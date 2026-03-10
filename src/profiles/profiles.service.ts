import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileInput } from './profiles.types';
import { UpstashRedisCacheService } from '../cache/upstash-redis-cache.service';
import { FilesService } from '../files/files.service';

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: UpstashRedisCacheService,
    private readonly files: FilesService,
  ) {}

  private normalizeOptionalText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async invalidateWorkspaceBootstrapForUserAndOrgMembers(userId: string): Promise<void> {
    const orgRows = await this.prisma.$queryRaw<Array<{ org_id: string }>>`
      select om.org_id
      from public.org_members om
      where om.user_id = ${userId}::uuid
        and om.status = 'active'
    `;

    const orgIds = Array.from(
      new Set(
        orgRows
          .map((row) => this.normalizeOptionalText(row.org_id))
          .filter((orgId): orgId is string => !!orgId),
      ),
    );

    let userIds = [userId];
    if (orgIds.length > 0) {
      const memberRows = await this.prisma.$queryRaw<Array<{ user_id: string }>>`
        select distinct om.user_id::text as user_id
        from public.org_members om
        where om.org_id = any(${orgIds}::uuid[])
          and om.status = 'active'
      `;
      userIds = Array.from(
        new Set([
          userId,
          ...memberRows
            .map((row) => this.normalizeOptionalText(row.user_id))
            .filter((memberId): memberId is string => !!memberId),
        ]),
      );
    }

    try {
      const keys = userIds.flatMap((targetUserId) => [
        this.cache.workspaceIdentityKey(targetUserId),
        this.cache.workspaceBootstrapKey(targetUserId),
        ...this.cache.workspaceSettingsSnapshotKeysForUser(targetUserId),
      ]);
      await this.cache.deleteMany(keys);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown cache invalidation error';
      this.logger.warn(`Failed to invalidate workspace bootstrap cache: ${message}`);
    }
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<void> {
    const existingRows = await this.prisma.$queryRaw<Array<{ avatar_url: string | null }>>`
      select avatar_url
      from public.profiles
      where id = ${userId}::uuid
    `;
    const previousAvatarUrl = existingRows[0]?.avatar_url
      ? this.normalizeOptionalText(existingRows[0].avatar_url)
      : null;

    const fullName = input.fullName?.trim() || null;
    const location = input.location?.trim() || null;
    const bio = input.bio?.trim() || null;
    const avatarUrl = input.avatarUrl?.trim() || null;
    const phone = input.phone?.trim() || null;
    const headline = input.headline?.trim() || null;
    const websiteUrl = input.websiteUrl?.trim() || null;
    const linkedinUrl = input.linkedinUrl?.trim() || null;
    const timezoneName = input.timezoneName?.trim() || null;
    const preferredContactMethodRaw = input.preferredContactMethod?.trim().toLowerCase() || null;
    const preferredContactMethod =
      preferredContactMethodRaw === 'email' ||
      preferredContactMethodRaw === 'phone' ||
      preferredContactMethodRaw === 'linkedin'
        ? preferredContactMethodRaw
        : null;

    await this.prisma.$queryRaw`
      insert into public.profiles (
        id,
        full_name,
        location,
        bio,
        avatar_url,
        phone,
        headline,
        website_url,
        linkedin_url,
        timezone_name,
        preferred_contact_method,
        updated_at
      )
      values (
        ${userId}::uuid,
        ${fullName},
        ${location},
        ${bio},
        ${avatarUrl},
        ${phone},
        ${headline},
        ${websiteUrl},
        ${linkedinUrl},
        ${timezoneName},
        ${preferredContactMethod},
        timezone('utc', now())
      )
      on conflict (id) do update
      set
        full_name = excluded.full_name,
        location = excluded.location,
        bio = excluded.bio,
        avatar_url = excluded.avatar_url,
        phone = excluded.phone,
        headline = excluded.headline,
        website_url = excluded.website_url,
        linkedin_url = excluded.linkedin_url,
        timezone_name = excluded.timezone_name,
        preferred_contact_method = excluded.preferred_contact_method,
        updated_at = timezone('utc', now())
    `;

    if (previousAvatarUrl && previousAvatarUrl !== avatarUrl) {
      void this.files.deleteObjectByPublicUrl(previousAvatarUrl).catch((error) => {
        const message = error instanceof Error ? error.message : 'Unknown R2 delete error';
        this.logger.warn(`Failed to delete previous avatar from R2: ${message}`);
      });
    }

    void this.invalidateWorkspaceBootstrapForUserAndOrgMembers(userId).catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown cache invalidation error';
      this.logger.warn(`Failed to schedule workspace cache invalidation: ${message}`);
    });
  }
}
