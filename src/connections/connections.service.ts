import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConnectionRequestInput } from './connections.types';
import type {
  ConnectionMessageView,
  ConnectionRequestView,
  ConnectionView,
} from './connections.types';

type MembershipContext = { orgId: string; orgType: string };

@Injectable()
export class ConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getRequesterContext(userId: string): Promise<MembershipContext> {
    const rows = await this.prisma.$queryRaw<
      Array<{ org_id: string; org_type: string }>
    >`
      select om.org_id, o.type::text as org_type
      from public.org_members om
      join public.organizations o on o.id = om.org_id
      left join public.org_status s on s.org_id = o.id
      where om.user_id = ${userId}::uuid
        and om.status = 'active'
        and coalesce(s.status::text, 'active') = 'active'
      order by om.created_at asc
      limit 1
    `;
    const row = rows[0];
    if (!row?.org_id || !row?.org_type) {
      throw new Error('Organization membership is required');
    }
    return { orgId: row.org_id, orgType: row.org_type.toLowerCase() };
  }

  async createRequest(
    userId: string,
    input: CreateConnectionRequestInput,
  ): Promise<ConnectionRequestView> {
    const ctx = await this.getRequesterContext(userId);
    if (ctx.orgType !== 'investor' && ctx.orgType !== 'advisor') {
      throw new Error('Only investors and advisors can send connection requests');
    }
    const toOrgId = input.toOrgId.trim();
    const toOrgRows = await this.prisma.$queryRaw<
      Array<{ id: string; type: string; name: string }>
    >`
      select id, type::text as type, name from public.organizations where id = ${toOrgId}::uuid limit 1
    `;
    const toOrg = toOrgRows[0];
    if (!toOrg || toOrg.type !== 'startup') {
      throw new Error('Connection requests can only be sent to startups');
    }
    if (toOrgId === ctx.orgId) {
      throw new Error('Cannot send a connection request to your own organization');
    }
    const message = input.message?.trim() || null;
    const fromNameRows = await this.prisma.$queryRaw<Array<{ name: string }>>`
      select name from public.organizations where id = ${ctx.orgId}::uuid limit 1
    `;
    const fromName = fromNameRows[0]?.name ?? '';

    const inserted = await this.prisma.$queryRaw<
      Array<{
        id: string;
        from_org_id: string;
        to_org_id: string;
        status: string;
        message: string | null;
        created_at: Date;
        responded_at: Date | null;
      }>
    >`
      insert into public.connection_requests (from_org_id, to_org_id, status, message)
      values (${ctx.orgId}::uuid, ${toOrgId}::uuid, 'pending'::public.connection_request_status, ${message})
      on conflict (from_org_id, to_org_id) do update
      set message = excluded.message, status = 'pending'::public.connection_request_status, responded_at = null
      returning id, from_org_id, to_org_id, status::text as status, message, created_at, responded_at
    `;
    const r = inserted[0];
    if (!r) throw new Error('Failed to create connection request');
    return {
      id: r.id,
      from_org_id: r.from_org_id,
      from_org_name: fromName,
      to_org_id: r.to_org_id,
      to_org_name: toOrg.name,
      status: r.status as ConnectionRequestView['status'],
      message: r.message,
      created_at: r.created_at.toISOString(),
      responded_at: r.responded_at?.toISOString() ?? null,
    };
  }

  async listIncomingRequests(userId: string): Promise<ConnectionRequestView[]> {
    const ctx = await this.getRequesterContext(userId);
    if (ctx.orgType !== 'startup') return [];
    const list = await this.prisma.$queryRaw<
      Array<{
        id: string;
        from_org_id: string;
        from_org_name: string;
        to_org_id: string;
        to_org_name: string;
        status: string;
        message: string | null;
        created_at: Date;
        responded_at: Date | null;
      }>
    >`
      select
        cr.id, cr.from_org_id, cr.to_org_id, cr.status::text as status, cr.message, cr.created_at, cr.responded_at,
        fo.name as from_org_name, to_org.name as to_org_name
      from public.connection_requests cr
      join public.organizations fo on fo.id = cr.from_org_id
      join public.organizations to_org on to_org.id = cr.to_org_id
      where cr.to_org_id = ${ctx.orgId}::uuid and cr.status = 'pending'
      order by cr.created_at desc
    `;
    return list.map((r) => ({
      id: r.id,
      from_org_id: r.from_org_id,
      from_org_name: r.from_org_name,
      to_org_id: r.to_org_id,
      to_org_name: r.to_org_name,
      status: r.status as ConnectionRequestView['status'],
      message: r.message,
      created_at: r.created_at.toISOString(),
      responded_at: r.responded_at?.toISOString() ?? null,
    }));
  }

  async listOutgoingRequests(userId: string): Promise<ConnectionRequestView[]> {
    const ctx = await this.getRequesterContext(userId);
    const list = await this.prisma.$queryRaw<
      Array<{
        id: string;
        from_org_id: string;
        from_org_name: string;
        to_org_id: string;
        to_org_name: string;
        status: string;
        message: string | null;
        created_at: Date;
        responded_at: Date | null;
      }>
    >`
      select
        cr.id, cr.from_org_id, cr.to_org_id, cr.status::text as status, cr.message, cr.created_at, cr.responded_at,
        fo.name as from_org_name, to_org.name as to_org_name
      from public.connection_requests cr
      join public.organizations fo on fo.id = cr.from_org_id
      join public.organizations to_org on to_org.id = cr.to_org_id
      where cr.from_org_id = ${ctx.orgId}::uuid
      order by cr.created_at desc
    `;
    return list.map((r) => ({
      id: r.id,
      from_org_id: r.from_org_id,
      from_org_name: r.from_org_name,
      to_org_id: r.to_org_id,
      to_org_name: r.to_org_name,
      status: r.status as ConnectionRequestView['status'],
      message: r.message,
      created_at: r.created_at.toISOString(),
      responded_at: r.responded_at?.toISOString() ?? null,
    }));
  }

  async acceptRequest(userId: string, requestId: string): Promise<ConnectionView> {
    const ctx = await this.getRequesterContext(userId);
    if (ctx.orgType !== 'startup') {
      throw new Error('Only startups can accept connection requests');
    }
    const reqRows = await this.prisma.$queryRaw<
      Array<{ from_org_id: string; to_org_id: string }>
    >`
      select from_org_id, to_org_id from public.connection_requests
      where id = ${requestId}::uuid and to_org_id = ${ctx.orgId}::uuid and status = 'pending'
      limit 1
    `;
    const req = reqRows[0];
    if (!req) throw new Error('Connection request not found or already responded');
    const orgA = req.from_org_id < req.to_org_id ? req.from_org_id : req.to_org_id;
    const orgB = req.from_org_id < req.to_org_id ? req.to_org_id : req.from_org_id;
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        update public.connection_requests set status = 'accepted'::public.connection_request_status, responded_at = timezone('utc', now())
        where id = ${requestId}::uuid
      `;
      await tx.$queryRaw`
        insert into public.connections (org_a_id, org_b_id)
        values (${orgA}::uuid, ${orgB}::uuid)
        on conflict (org_a_id, org_b_id) do nothing
      `;
    });
    const connRows = await this.prisma.$queryRaw<
      Array<{ id: string; org_a_id: string; org_b_id: string; org_a_name: string; org_b_name: string; created_at: Date }>
    >`
      select c.id, c.org_a_id, c.org_b_id, c.created_at, oa.name as org_a_name, ob.name as org_b_name
      from public.connections c
      join public.organizations oa on oa.id = c.org_a_id
      join public.organizations ob on ob.id = c.org_b_id
      where (c.org_a_id = ${req.from_org_id}::uuid and c.org_b_id = ${req.to_org_id}::uuid)
         or (c.org_a_id = ${req.to_org_id}::uuid and c.org_b_id = ${req.from_org_id}::uuid)
      limit 1
    `;
    const conn = connRows[0];
    if (!conn) throw new Error('Connection not found');
    const otherId = conn.org_a_id === ctx.orgId ? conn.org_b_id : conn.org_a_id;
    const otherName = conn.org_a_id === ctx.orgId ? conn.org_b_name : conn.org_a_name;
    return {
      id: conn.id,
      org_a_id: conn.org_a_id,
      org_b_id: conn.org_b_id,
      other_org_id: otherId,
      other_org_name: otherName,
      created_at: conn.created_at.toISOString(),
    };
  }

  async rejectRequest(userId: string, requestId: string): Promise<void> {
    const ctx = await this.getRequesterContext(userId);
    if (ctx.orgType !== 'startup') {
      throw new Error('Only startups can reject connection requests');
    }
    const result = await this.prisma.$queryRaw<Array<{ n: number }>>`
      update public.connection_requests
      set status = 'rejected'::public.connection_request_status, responded_at = timezone('utc', now())
      where id = ${requestId}::uuid and to_org_id = ${ctx.orgId}::uuid and status = 'pending'
      returning 1 as n
    `;
    if (!result?.length) {
      throw new Error('Connection request not found or already responded');
    }
  }

  async listConnections(userId: string): Promise<ConnectionView[]> {
    const ctx = await this.getRequesterContext(userId);
    const list = await this.prisma.$queryRaw<
      Array<{
        id: string;
        org_a_id: string;
        org_b_id: string;
        other_org_id: string;
        other_org_name: string;
        created_at: Date;
      }>
    >`
      select
        c.id, c.org_a_id, c.org_b_id, c.created_at,
        case when c.org_a_id = ${ctx.orgId}::uuid then c.org_b_id else c.org_a_id end as other_org_id,
        case when c.org_a_id = ${ctx.orgId}::uuid then ob.name else oa.name end as other_org_name
      from public.connections c
      join public.organizations oa on oa.id = c.org_a_id
      join public.organizations ob on ob.id = c.org_b_id
      where c.org_a_id = ${ctx.orgId}::uuid or c.org_b_id = ${ctx.orgId}::uuid
      order by c.created_at desc
    `;
    return list.map((c) => ({
      id: c.id,
      org_a_id: c.org_a_id,
      org_b_id: c.org_b_id,
      other_org_id: c.other_org_id,
      other_org_name: c.other_org_name,
      created_at: c.created_at.toISOString(),
    }));
  }

  async listMessages(
    userId: string,
    connectionId: string,
  ): Promise<ConnectionMessageView[]> {
    const ctx = await this.getRequesterContext(userId);
    const connRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      select id from public.connections
      where id = ${connectionId}::uuid and (org_a_id = ${ctx.orgId}::uuid or org_b_id = ${ctx.orgId}::uuid)
      limit 1
    `;
    if (!connRows.length) throw new Error('Connection not found');
    const messages = await this.prisma.$queryRaw<
      Array<{
        id: string;
        connection_id: string;
        from_org_id: string;
        from_org_name: string;
        body: string;
        created_at: Date;
      }>
    >`
      select m.id, m.connection_id, m.from_org_id, m.body, m.created_at, o.name as from_org_name
      from public.connection_messages m
      join public.organizations o on o.id = m.from_org_id
      where m.connection_id = ${connectionId}::uuid
      order by m.created_at asc
    `;
    return messages.map((m) => ({
      id: m.id,
      connection_id: m.connection_id,
      from_org_id: m.from_org_id,
      from_org_name: m.from_org_name,
      body: m.body,
      created_at: m.created_at.toISOString(),
    }));
  }

  async sendMessage(
    userId: string,
    connectionId: string,
    body: string,
  ): Promise<ConnectionMessageView> {
    const ctx = await this.getRequesterContext(userId);
    const connRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      select id from public.connections
      where id = ${connectionId}::uuid and (org_a_id = ${ctx.orgId}::uuid or org_b_id = ${ctx.orgId}::uuid)
      limit 1
    `;
    if (!connRows.length) throw new Error('Connection not found');
    const trimmed = body?.trim();
    if (!trimmed || trimmed.length > 10000) {
      throw new Error('Message must be 1–10000 characters');
    }
    const fromNameRows = await this.prisma.$queryRaw<Array<{ name: string }>>`
      select name from public.organizations where id = ${ctx.orgId}::uuid limit 1
    `;
    const fromName = fromNameRows[0]?.name ?? '';
    const inserted = await this.prisma.$queryRaw<
      Array<{ id: string; connection_id: string; from_org_id: string; body: string; created_at: Date }>
    >`
      insert into public.connection_messages (connection_id, from_org_id, body)
      values (${connectionId}::uuid, ${ctx.orgId}::uuid, ${trimmed})
      returning id, connection_id, from_org_id, body, created_at
    `;
    const m = inserted[0];
    if (!m) throw new Error('Failed to send message');
    return {
      id: m.id,
      connection_id: m.connection_id,
      from_org_id: m.from_org_id,
      from_org_name: fromName,
      body: m.body,
      created_at: m.created_at.toISOString(),
    };
  }

  async countPendingIncoming(userId: string): Promise<number> {
    const ctx = await this.getRequesterContext(userId);
    if (ctx.orgType !== 'startup') return 0;
    const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
      select count(*)::int as n from public.connection_requests
      where to_org_id = ${ctx.orgId}::uuid and status = 'pending'
    `;
    return rows[0]?.n ?? 0;
  }
}
