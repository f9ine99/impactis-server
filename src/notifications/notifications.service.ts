import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { NotificationView } from './notifications.types';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async createForUser(
    userId: string,
    params: { type: string; title: string; body?: string | null; link?: string | null },
  ): Promise<void> {
    await this.prisma.$executeRaw`
      insert into public.notifications (user_id, type, title, body, link)
      values (${userId}::uuid, ${params.type}, ${params.title}, ${params.body ?? null}, ${params.link ?? null})
    `;
  }

  /** Create a notification for every active member of the organization. */
  async createForOrg(
    orgId: string,
    params: { type: string; title: string; body?: string | null; link?: string | null },
  ): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ user_id: string }>>`
      select om.user_id
      from public.org_members om
      left join public.org_status s on s.org_id = om.org_id
      where om.org_id = ${orgId}::uuid and om.status = 'active'
        and coalesce(s.status::text, 'active') = 'active'
    `;
    for (const row of rows) {
      await this.createForUser(row.user_id, params);
    }
  }

  async listForUser(userId: string, limit = 50): Promise<NotificationView[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        type: string;
        title: string;
        body: string | null;
        link: string | null;
        read_at: Date | null;
        created_at: Date;
      }>
    >`
      select id, type, title, body, link, read_at, created_at
      from public.notifications
      where user_id = ${userId}::uuid
      order by created_at desc
      limit ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      read_at: r.read_at?.toISOString() ?? null,
      created_at: r.created_at.toISOString(),
    }));
  }

  async markRead(userId: string, notificationId: string): Promise<boolean> {
    const result = await this.prisma.$executeRaw`
      update public.notifications
      set read_at = timezone('utc', now())
      where id = ${notificationId}::uuid and user_id = ${userId}::uuid and read_at is null
    `;
    return Number(result) > 0;
  }

  async getUnreadCount(userId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
      select count(*)::int as n from public.notifications
      where user_id = ${userId}::uuid and read_at is null
    `;
    return rows[0]?.n ?? 0;
  }
}
