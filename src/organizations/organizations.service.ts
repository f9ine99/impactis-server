import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UpstashRedisCacheService } from '../cache/upstash-redis-cache.service';
import {
  CreateOrganizationInviteInput,
  CreateOrganizationInvitePayload,
  CreateOrganizationWithOwnerInput,
  OrganizationIncomingInviteView,
  OrganizationMemberDirectoryEntryView,
  OrganizationMembershipView,
  OrganizationOutgoingInviteView,
  OrganizationVerificationOverviewView,
  OrganizationVerificationView,
  UpdateOrganizationIdentityInput,
} from './organizations.types';

type PrimaryOrgMembershipContext = {
  orgId: string;
  memberRole: string;
  orgStatus: string;
};

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: UpstashRedisCacheService,
  ) {}

  private normalizeOptionalText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeIndustryTags(value: string[] | null | undefined): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const deduped: string[] = [];
    for (const rawTag of value) {
      const tag = this.normalizeOptionalText(rawTag);
      if (!tag) {
        continue;
      }

      if (tag.length < 2 || tag.length > 48) {
        throw new Error('Industry tags must be between 2 and 48 characters');
      }

      if (!deduped.includes(tag)) {
        deduped.push(tag);
      }
    }

    if (deduped.length > 20) {
      throw new Error('A maximum of 20 industry tags is allowed');
    }

    return deduped;
  }

  private normalizeOrganizationType(value: string | null | undefined): 'startup' | 'advisor' | 'investor' | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase() ?? null;
    if (normalized === 'startup' || normalized === 'advisor' || normalized === 'investor') {
      return normalized;
    }

    return null;
  }

  private normalizeMemberRole(value: string | null | undefined): 'owner' | 'admin' | 'member' | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase() ?? null;
    if (normalized === 'owner' || normalized === 'admin' || normalized === 'member') {
      return normalized;
    }

    return null;
  }

  private normalizeMembershipStatus(
    value: string | null | undefined,
  ): 'pending' | 'active' | 'left' | 'removed' | 'expired' | 'cancelled' | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase() ?? null;
    if (
      normalized === 'pending'
      || normalized === 'active'
      || normalized === 'left'
      || normalized === 'removed'
      || normalized === 'expired'
      || normalized === 'cancelled'
    ) {
      return normalized;
    }

    return null;
  }

  private normalizeVerificationStatus(
    value: string | null | undefined,
  ): 'unverified' | 'pending' | 'approved' | 'rejected' {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase() ?? null;
    if (
      normalized === 'unverified'
      || normalized === 'pending'
      || normalized === 'approved'
      || normalized === 'rejected'
    ) {
      return normalized;
    }

    return 'unverified';
  }

  private normalizeInviteStatus(
    value: string | null | undefined,
  ): 'pending' | 'accepted' | 'expired' | 'cancelled' | 'revoked' | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase() ?? null;
    if (
      normalized === 'pending'
      || normalized === 'accepted'
      || normalized === 'expired'
      || normalized === 'cancelled'
      || normalized === 'revoked'
    ) {
      return normalized;
    }

    return null;
  }

  private normalizeTimestamp(value: string | Date | null | undefined): string | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async resolvePrimaryOrgMembershipContext(
    userId: string,
  ): Promise<PrimaryOrgMembershipContext> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        org_id: string;
        member_role: string | null;
        org_status: string | null;
      }>
    >`
      select
        om.org_id,
        om.member_role::text as member_role,
        coalesce(os.status::text, 'active') as org_status
      from public.org_members om
      join public.organizations o on o.id = om.org_id
      left join public.org_status os on os.org_id = o.id
      where om.user_id = ${userId}::uuid
        and om.status = 'active'
      order by om.created_at asc
      limit 1
    `;

    const membership = rows[0];
    if (!membership?.org_id) {
      throw new Error('Organization membership is required');
    }

    return {
      orgId: membership.org_id,
      memberRole: this.normalizeOptionalText(membership.member_role)?.toLowerCase() ?? '',
      orgStatus: this.normalizeOptionalText(membership.org_status)?.toLowerCase() ?? 'active',
    };
  }

  private async resolveUserEmail(userId: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ email: string | null }>>`
      select lower(trim(coalesce(u.email, ''))) as email
      from auth.users u
      where u.id = ${userId}::uuid
      limit 1
    `;

    const email = this.normalizeOptionalText(rows[0]?.email)?.toLowerCase() ?? null;
    if (!email) {
      throw new Error('User email is required to accept invite');
    }

    return email;
  }

  private async isActiveMemberOfOrg(userId: string, orgId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      select true as exists
      from public.org_members om
      where om.org_id = ${orgId}::uuid
        and om.user_id = ${userId}::uuid
        and om.status = 'active'
      limit 1
    `;

    return rows[0]?.exists === true;
  }

  private async assertOwnerAccessForOrg(userId: string, orgId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        member_role: string | null;
        org_status: string | null;
      }>
    >`
      select
        om.member_role::text as member_role,
        coalesce(os.status::text, 'active') as org_status
      from public.org_members om
      join public.organizations o on o.id = om.org_id
      left join public.org_status os on os.org_id = o.id
      where om.user_id = ${userId}::uuid
        and om.org_id = ${orgId}::uuid
        and om.status = 'active'
      limit 1
    `;

    const context = rows[0];
    const memberRole = this.normalizeMemberRole(context?.member_role);
    if (memberRole !== 'owner') {
      throw new Error('Only organization owner can access this operation');
    }

    const orgStatus = this.normalizeOptionalText(context?.org_status)?.toLowerCase() ?? 'active';
    if (orgStatus !== 'active') {
      throw new Error('Organization is not active');
    }
  }

  private async listActiveOrganizationMemberUserIds(orgId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ user_id: string }>>`
      select om.user_id::text as user_id
      from public.org_members om
      where om.org_id = ${orgId}::uuid
        and om.status = 'active'
    `;

    return rows
      .map((row) => this.normalizeOptionalText(row.user_id))
      .filter((row): row is string => !!row);
  }

  private async invalidateWorkspaceBootstrapForUsers(userIds: string[]): Promise<void> {
    const normalizedUserIds = Array.from(
      new Set(
        userIds
          .map((userId) => this.normalizeOptionalText(userId))
          .filter((userId): userId is string => !!userId),
      ),
    );
    if (normalizedUserIds.length < 1) {
      return;
    }

    const keys = normalizedUserIds.flatMap((userId) => [
      this.cache.workspaceIdentityKey(userId),
      this.cache.workspaceBootstrapKey(userId),
      ...this.cache.workspaceSettingsSnapshotKeysForUser(userId),
    ]);

    void this.cache.deleteMany(keys).catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown cache invalidation error';
      this.logger.warn(`Failed to invalidate workspace caches: ${message}`);
    });
  }

  private async invalidateWorkspaceBootstrapForOrg(orgId: string): Promise<void> {
    try {
      const memberUserIds = await this.listActiveOrganizationMemberUserIds(orgId);
      await this.invalidateWorkspaceBootstrapForUsers(memberUserIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown cache invalidation error';
      this.logger.warn(`Failed to invalidate workspace caches: ${message}`);
    }
  }

  async getPrimaryOrganizationMembershipByUserId(
    userId: string,
  ): Promise<OrganizationMembershipView | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        org_id: string;
        user_id: string;
        member_role: string | null;
        status: string | null;
        created_at: string | Date | null;
        organization_id: string;
        organization_type: string | null;
        organization_name: string;
        organization_location: string | null;
        organization_logo_url: string | null;
        organization_industry_tags: string[] | null;
        organization_created_at: string | Date | null;
      }>
    >`
      select
        om.org_id,
        om.user_id,
        om.member_role::text as member_role,
        om.status::text as status,
        om.created_at,
        o.id as organization_id,
        o.type::text as organization_type,
        o.name as organization_name,
        o.location as organization_location,
        o.logo_url as organization_logo_url,
        o.industry_tags as organization_industry_tags,
        o.created_at as organization_created_at
      from public.org_members om
      join public.organizations o on o.id = om.org_id
      where om.user_id = ${userId}::uuid
        and om.status = 'active'
      order by om.created_at asc
      limit 1
    `;

    const row = rows[0];
    if (!row) {
      return null;
    }

    const memberRole = this.normalizeMemberRole(row.member_role);
    const membershipStatus = this.normalizeMembershipStatus(row.status);
    const orgType = this.normalizeOrganizationType(row.organization_type);
    const createdAt = this.normalizeTimestamp(row.created_at);
    const orgCreatedAt = this.normalizeTimestamp(row.organization_created_at);
    if (!memberRole || !membershipStatus || !orgType || !createdAt || !orgCreatedAt) {
      return null;
    }

    return {
      org_id: row.org_id,
      user_id: row.user_id,
      member_role: memberRole,
      status: membershipStatus,
      created_at: createdAt,
      organization: {
        id: row.organization_id,
        type: orgType,
        name: row.organization_name,
        location: row.organization_location,
        logo_url: row.organization_logo_url,
        industry_tags: Array.isArray(row.organization_industry_tags) ? row.organization_industry_tags : [],
        created_at: orgCreatedAt,
      },
    };
  }

  async hasOrganizationMembershipForUser(userId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      select true as exists
      from public.org_members om
      where om.user_id = ${userId}::uuid
        and om.status = 'active'
      limit 1
    `;

    return rows[0]?.exists === true;
  }

  async getOrganizationVerificationByOrgId(
    userId: string,
    orgId: string,
  ): Promise<OrganizationVerificationView> {
    const normalizedOrgId = this.normalizeOptionalText(orgId);
    if (!normalizedOrgId) {
      throw new Error('Organization id is required');
    }

    const hasAccess = await this.isActiveMemberOfOrg(userId, normalizedOrgId);
    if (!hasAccess) {
      throw new Error('Organization membership is required');
    }

    const rows = await this.prisma.$queryRaw<
      Array<{
        org_id: string;
        status: string | null;
        reviewed_by: string | null;
        reviewed_at: string | Date | null;
        notes: string | null;
      }>
    >`
      select
        ${normalizedOrgId}::uuid as org_id,
        ov.status::text as status,
        ov.reviewed_by,
        ov.reviewed_at,
        ov.notes
      from public.org_verifications ov
      where ov.org_id = ${normalizedOrgId}::uuid
      limit 1
    `;

    const row = rows[0];
    return {
      org_id: normalizedOrgId,
      status: this.normalizeVerificationStatus(row?.status),
      reviewed_by: row?.reviewed_by ?? null,
      reviewed_at: this.normalizeTimestamp(row?.reviewed_at) ?? null,
      notes: row?.notes ?? null,
    };
  }

  async listOrganizationInvitesForOrg(
    userId: string,
    orgId: string,
    statuses: string[],
  ): Promise<OrganizationOutgoingInviteView[]> {
    const normalizedOrgId = this.normalizeOptionalText(orgId);
    if (!normalizedOrgId) {
      throw new Error('Organization id is required');
    }

    await this.assertOwnerAccessForOrg(userId, normalizedOrgId);

    const normalizedStatuses = statuses
      .map((status) => this.normalizeInviteStatus(status))
      .filter((status): status is NonNullable<ReturnType<typeof this.normalizeInviteStatus>> => !!status);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        org_id: string;
        invited_email: string;
        member_role: string | null;
        status: string | null;
        invited_by: string;
        accepted_by: string | null;
        expires_at: string | Date;
        created_at: string | Date;
        responded_at: string | Date | null;
      }>
    >`
      select
        oi.id,
        oi.org_id,
        oi.invited_email,
        oi.member_role::text as member_role,
        oi.status::text as status,
        oi.invited_by,
        oi.accepted_by,
        oi.expires_at,
        oi.created_at,
        oi.responded_at
      from public.org_invites oi
      where oi.org_id = ${normalizedOrgId}::uuid
        and (
          array_length(${normalizedStatuses}::text[], 1) is null
          or oi.status::text = any(${normalizedStatuses}::text[])
        )
      order by oi.created_at desc
    `;

    return rows
      .map((row): OrganizationOutgoingInviteView | null => {
        const memberRole = this.normalizeMemberRole(row.member_role);
        const status = this.normalizeInviteStatus(row.status);
        const expiresAt = this.normalizeTimestamp(row.expires_at);
        const createdAt = this.normalizeTimestamp(row.created_at);
        if (!memberRole || !status || !expiresAt || !createdAt) {
          return null;
        }

        return {
          id: row.id,
          org_id: row.org_id,
          invited_email: row.invited_email,
          member_role: memberRole,
          status,
          invited_by: row.invited_by,
          accepted_by: row.accepted_by,
          expires_at: expiresAt,
          created_at: createdAt,
          responded_at: this.normalizeTimestamp(row.responded_at),
        };
      })
      .filter((row): row is OrganizationOutgoingInviteView => !!row);
  }

  async countOrganizationInvitesForOrg(
    userId: string,
    orgId: string,
    statuses: string[],
  ): Promise<number> {
    const normalizedOrgId = this.normalizeOptionalText(orgId);
    if (!normalizedOrgId) {
      throw new Error('Organization id is required');
    }

    await this.assertOwnerAccessForOrg(userId, normalizedOrgId);

    const normalizedStatuses = statuses
      .map((status) => this.normalizeInviteStatus(status))
      .filter((status): status is NonNullable<ReturnType<typeof this.normalizeInviteStatus>> => !!status);

    const rows = await this.prisma.$queryRaw<Array<{ total: number | string | null }>>`
      select count(*)::integer as total
      from public.org_invites oi
      where oi.org_id = ${normalizedOrgId}::uuid
        and (
          array_length(${normalizedStatuses}::text[], 1) is null
          or oi.status::text = any(${normalizedStatuses}::text[])
        )
    `;

    const value = rows[0]?.total;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.trunc(value));
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    }

    return 0;
  }

  async listActiveOrganizationMembersForOrg(
    userId: string,
    orgId: string,
  ): Promise<OrganizationMemberDirectoryEntryView[]> {
    const normalizedOrgId = this.normalizeOptionalText(orgId);
    if (!normalizedOrgId) {
      throw new Error('Organization id is required');
    }

    const hasAccess = await this.isActiveMemberOfOrg(userId, normalizedOrgId);
    if (!hasAccess) {
      throw new Error('Organization membership is required');
    }

    const rows = await this.prisma.$queryRaw<
      Array<{
        user_id: string;
        member_role: string | null;
        status: string | null;
        joined_at: string | Date | null;
        created_at: string | Date | null;
        full_name: string | null;
        avatar_url: string | null;
        location: string | null;
      }>
    >`
      select
        om.user_id,
        om.member_role::text as member_role,
        om.status::text as status,
        om.joined_at,
        om.created_at,
        p.full_name,
        p.avatar_url,
        p.location
      from public.org_members om
      left join public.profiles p on p.id = om.user_id
      where om.org_id = ${normalizedOrgId}::uuid
        and om.status = 'active'
      order by om.created_at asc
    `;

    return rows
      .map((row): OrganizationMemberDirectoryEntryView | null => {
        const memberRole = this.normalizeMemberRole(row.member_role);
        const status = this.normalizeMembershipStatus(row.status);
        if (!memberRole || !status) {
          return null;
        }

        return {
          user_id: row.user_id,
          member_role: memberRole,
          status,
          joined_at: this.normalizeTimestamp(row.joined_at) ?? this.normalizeTimestamp(row.created_at),
          full_name: row.full_name,
          avatar_url: row.avatar_url,
          location: row.location,
        };
      })
      .filter((row): row is OrganizationMemberDirectoryEntryView => !!row);
  }

  async listOrganizationsWithVerification(limit = 100): Promise<OrganizationVerificationOverviewView[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const rows = await this.prisma.$queryRaw<
      Array<{
        organization_id: string;
        organization_type: string | null;
        organization_name: string;
        organization_location: string | null;
        organization_logo_url: string | null;
        organization_industry_tags: string[] | null;
        organization_created_at: string | Date | null;
        verification_status: string | null;
        reviewed_by: string | null;
        reviewed_at: string | Date | null;
        notes: string | null;
      }>
    >`
      select
        o.id as organization_id,
        o.type::text as organization_type,
        o.name as organization_name,
        o.location as organization_location,
        o.logo_url as organization_logo_url,
        o.industry_tags as organization_industry_tags,
        o.created_at as organization_created_at,
        coalesce(ov.status::text, 'unverified') as verification_status,
        ov.reviewed_by,
        ov.reviewed_at,
        ov.notes
      from public.organizations o
      left join public.org_verifications ov on ov.org_id = o.id
      order by o.created_at desc
      limit ${boundedLimit}
    `;

    return rows
      .map((row): OrganizationVerificationOverviewView | null => {
        const orgType = this.normalizeOrganizationType(row.organization_type);
        const orgCreatedAt = this.normalizeTimestamp(row.organization_created_at);
        if (!orgType || !orgCreatedAt) {
          return null;
        }

        return {
          organization: {
            id: row.organization_id,
            type: orgType,
            name: row.organization_name,
            location: row.organization_location,
            logo_url: row.organization_logo_url,
            industry_tags: Array.isArray(row.organization_industry_tags) ? row.organization_industry_tags : [],
            created_at: orgCreatedAt,
          },
          verification: {
            org_id: row.organization_id,
            status: this.normalizeVerificationStatus(row.verification_status),
            reviewed_by: row.reviewed_by,
            reviewed_at: this.normalizeTimestamp(row.reviewed_at),
            notes: row.notes,
          },
        };
      })
      .filter((row): row is OrganizationVerificationOverviewView => !!row);
  }

  async setOrganizationVerificationStatus(input: {
    orgId: string;
    status: 'unverified' | 'pending' | 'approved' | 'rejected';
    reviewedByUserId: string;
    notes?: string | null;
  }): Promise<OrganizationVerificationView> {
    const normalizedOrgId = this.normalizeOptionalText(input.orgId);
    if (!normalizedOrgId) {
      throw new Error('Organization id is required');
    }

    const notes = this.normalizeOptionalText(input.notes);
    const shouldMarkReviewed = input.status === 'approved' || input.status === 'rejected';

    const rows = await this.prisma.$queryRaw<
      Array<{
        org_id: string;
        status: string | null;
        reviewed_by: string | null;
        reviewed_at: string | Date | null;
        notes: string | null;
      }>
    >`
      insert into public.org_verifications (
        org_id,
        status,
        reviewed_by,
        reviewed_at,
        notes,
        updated_at
      )
      values (
        ${normalizedOrgId}::uuid,
        ${input.status}::public.org_verification_status,
        ${shouldMarkReviewed ? input.reviewedByUserId : null}::uuid,
        case when ${shouldMarkReviewed} then timezone('utc', now()) else null end,
        ${notes},
        timezone('utc', now())
      )
      on conflict (org_id) do update
      set
        status = excluded.status,
        reviewed_by = excluded.reviewed_by,
        reviewed_at = excluded.reviewed_at,
        notes = excluded.notes,
        updated_at = timezone('utc', now())
      returning
        org_id,
        status::text as status,
        reviewed_by,
        reviewed_at,
        notes
    `;

    const row = rows[0];
    if (!row?.org_id) {
      throw new Error('Unable to update verification status');
    }

    await this.invalidateWorkspaceBootstrapForOrg(row.org_id);

    return {
      org_id: row.org_id,
      status: this.normalizeVerificationStatus(row.status),
      reviewed_by: row.reviewed_by,
      reviewed_at: this.normalizeTimestamp(row.reviewed_at),
      notes: row.notes,
    };
  }

  async listMyOrganizationInvites(userId: string): Promise<OrganizationIncomingInviteView[]> {
    const email = await this.resolveUserEmail(userId);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        org_id: string;
        organization_name: string;
        organization_type: string;
        member_role: string;
        invited_email: string;
        invited_by: string;
        expires_at: string | Date;
        created_at: string | Date;
      }>
    >`
      select
        oi.id,
        oi.org_id,
        o.name as organization_name,
        o.type::text as organization_type,
        oi.member_role::text as member_role,
        oi.invited_email,
        oi.invited_by,
        oi.expires_at,
        oi.created_at
      from public.org_invites oi
      join public.organizations o on o.id = oi.org_id
      left join public.org_status os on os.org_id = o.id
      where oi.status = 'pending'::public.org_invite_status
        and oi.expires_at > timezone('utc', now())
        and lower(trim(oi.invited_email)) = ${email}
        and coalesce(os.status::text, 'active') = 'active'
      order by oi.created_at desc
    `;

    return rows
      .map((row) => {
        const expiresAt = this.normalizeTimestamp(row.expires_at);
        const createdAt = this.normalizeTimestamp(row.created_at);
        if (!expiresAt || !createdAt) {
          return null;
        }

        return {
          id: row.id,
          org_id: row.org_id,
          organization_name: row.organization_name,
          organization_type: row.organization_type,
          member_role: row.member_role,
          invited_email: row.invited_email,
          invited_by: row.invited_by,
          expires_at: expiresAt,
          created_at: createdAt,
        };
      })
      .filter((row): row is OrganizationIncomingInviteView => !!row);
  }

  async createOrganizationWithOwner(
    userId: string,
    input: CreateOrganizationWithOwnerInput,
  ): Promise<string> {
    const name = this.normalizeOptionalText(input.name);
    if (!name || name.length < 2) {
      throw new Error('Organization name is required');
    }

    const type = this.normalizeOrganizationType(input.type);
    if (!type) {
      throw new Error('Invalid organization type');
    }

    const location = this.normalizeOptionalText(input.location);
    const industryTags = this.normalizeIndustryTags(input.industryTags);

    const existingMembershipRows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      select true as exists
      from public.org_members om
      where om.user_id = ${userId}::uuid
      limit 1
    `;

    if (existingMembershipRows[0]?.exists) {
      throw new Error('User already belongs to an organization');
    }

    const orgId = await this.prisma.$transaction(async (tx) => {
      const orgRows = await tx.$queryRaw<Array<{ id: string }>>`
        insert into public.organizations (type, name, location, industry_tags)
        values (
          ${type}::public.org_type,
          ${name},
          ${location},
          ${industryTags}::text[]
        )
        returning id
      `;

      const orgId = orgRows[0]?.id;
      if (!orgId) {
        throw new Error('Unable to create organization right now');
      }

      await tx.$queryRaw`
        insert into public.org_members (
          org_id,
          user_id,
          member_role,
          status,
          invited_by,
          joined_at
        )
        values (
          ${orgId}::uuid,
          ${userId}::uuid,
          'owner'::public.org_member_role,
          'active'::public.org_membership_status,
          null,
          timezone('utc', now())
        )
      `;

      await tx.$queryRaw`
        insert into public.org_verifications (org_id, status)
        values (${orgId}::uuid, 'unverified'::public.org_verification_status)
      `;

      await tx.$queryRaw`
        insert into public.org_status (org_id, status)
        values (${orgId}::uuid, 'active'::public.org_lifecycle_status)
      `;

      return orgId;
    });

    await this.invalidateWorkspaceBootstrapForUsers([userId]);
    return orgId;
  }

  async updateOrganizationIdentity(
    userId: string,
    input: UpdateOrganizationIdentityInput,
  ): Promise<string> {
    const name = this.normalizeOptionalText(input.name);
    if (!name || name.length < 2) {
      throw new Error('Organization name must be at least 2 characters');
    }

    const location = this.normalizeOptionalText(input.location);
    const logoUrl = this.normalizeOptionalText(input.logoUrl);
    const industryTags = this.normalizeIndustryTags(input.industryTags);

    const membership = await this.resolvePrimaryOrgMembershipContext(userId);
    if (membership.memberRole !== 'owner') {
      throw new Error('Only owner can update organization settings');
    }
    if (membership.orgStatus !== 'active') {
      throw new Error('Organization is not active');
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      update public.organizations
      set
        name = ${name},
        location = ${location},
        industry_tags = ${industryTags}::text[],
        logo_url = ${logoUrl},
        updated_at = timezone('utc', now())
      where id = ${membership.orgId}::uuid
      returning id
    `;

    if (!rows[0]?.id) {
      throw new Error('Organization membership is required');
    }

    const orgId = rows[0].id;
    await this.invalidateWorkspaceBootstrapForOrg(orgId);
    return orgId;
  }

  async createOrganizationInvite(
    userId: string,
    input: CreateOrganizationInviteInput,
  ): Promise<CreateOrganizationInvitePayload> {
    const invitedEmail = this.normalizeOptionalText(input.invitedEmail)?.toLowerCase() ?? '';
    if (!invitedEmail) {
      throw new Error('Invited email is required');
    }

    const memberRole = (input.memberRole ?? 'member').trim().toLowerCase();
    if (memberRole !== 'admin' && memberRole !== 'member') {
      throw new Error('Invited member role must be admin or member');
    }

    const expiresAtRaw = this.normalizeOptionalText(input.expiresAt);
    let expiresAt: Date | null = null;
    if (expiresAtRaw) {
      const parsedExpiresAt = new Date(expiresAtRaw);
      if (Number.isNaN(parsedExpiresAt.getTime())) {
        throw new Error('Invite expiry timestamp is invalid');
      }
      expiresAt = parsedExpiresAt;
    }

    const membership = await this.resolvePrimaryOrgMembershipContext(userId);
    if (membership.memberRole !== 'owner') {
      throw new Error('Only organization owner can invite members');
    }
    if (membership.orgStatus !== 'active') {
      throw new Error('Only active organizations can send invites');
    }

    const existingMemberRows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      select true as exists
      from auth.users u
      join public.org_members om on om.user_id = u.id
      where om.org_id = ${membership.orgId}::uuid
        and om.status = 'active'
        and lower(trim(coalesce(u.email, ''))) = ${invitedEmail}
      limit 1
    `;
    if (existingMemberRows[0]?.exists) {
      throw new Error('User already belongs to this organization');
    }

    await this.prisma.$queryRaw`
      update public.org_invites
      set
        status = 'cancelled'::public.org_invite_status,
        responded_at = timezone('utc', now())
      where org_id = ${membership.orgId}::uuid
        and lower(trim(invited_email)) = ${invitedEmail}
        and status = 'pending'::public.org_invite_status
    `;

    const inviteToken = randomBytes(24).toString('hex');
    const tokenHash = createHash('sha256').update(inviteToken).digest('hex');

    const inviteRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      insert into public.org_invites (
        org_id,
        invited_email,
        member_role,
        status,
        invited_by,
        token_hash,
        expires_at
      )
      values (
        ${membership.orgId}::uuid,
        ${invitedEmail},
        ${memberRole}::public.org_member_role,
        'pending'::public.org_invite_status,
        ${userId}::uuid,
        ${tokenHash},
        coalesce(${expiresAt}::timestamptz, timezone('utc', now()) + interval '7 days')
      )
      returning id
    `;

    const inviteId = inviteRows[0]?.id ?? null;
    if (!inviteId) {
      throw new Error('Unable to create organization invite right now.');
    }

    await this.invalidateWorkspaceBootstrapForOrg(membership.orgId);

    return {
      success: true,
      message: null,
      inviteId,
      inviteToken,
    };
  }

  async revokeOrganizationInvite(userId: string, inviteId: string): Promise<void> {
    const normalizedId = this.normalizeOptionalText(inviteId);
    if (!normalizedId) {
      throw new Error('Invite id is required');
    }

    const membership = await this.resolvePrimaryOrgMembershipContext(userId);
    if (membership.memberRole !== 'owner') {
      throw new Error('Only organization owner can revoke invites');
    }
    if (membership.orgStatus !== 'active') {
      throw new Error('Only active organizations can revoke invites');
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      update public.org_invites
      set
        status = 'revoked'::public.org_invite_status,
        responded_at = timezone('utc', now())
      where id = ${normalizedId}::uuid
        and org_id = ${membership.orgId}::uuid
        and status = 'pending'::public.org_invite_status
      returning id
    `;

    if (!rows[0]?.id) {
      throw new Error('Pending invite not found for this organization');
    }

    await this.invalidateWorkspaceBootstrapForOrg(membership.orgId);
  }

  async acceptOrganizationInvite(userId: string, inviteToken: string): Promise<string> {
    const normalizedToken = this.normalizeOptionalText(inviteToken);
    if (!normalizedToken) {
      throw new Error('Invite token is required');
    }

    const userEmail = await this.resolveUserEmail(userId);
    const tokenHash = createHash('sha256').update(normalizedToken).digest('hex');

    const inviteRows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        org_id: string;
        member_role: string;
        invited_email: string;
        invited_by: string;
        expires_at: Date | string;
      }>
    >`
      select
        oi.id,
        oi.org_id,
        oi.member_role::text as member_role,
        oi.invited_email,
        oi.invited_by,
        oi.expires_at
      from public.org_invites oi
      where oi.token_hash = ${tokenHash}
        and oi.status = 'pending'::public.org_invite_status
      limit 1
    `;

    const invite = inviteRows[0];
    if (!invite?.id) {
      throw new Error('Invite not found or already processed');
    }

    const expiryDate =
      invite.expires_at instanceof Date ? invite.expires_at : new Date(invite.expires_at);
    if (Number.isNaN(expiryDate.getTime())) {
      throw new Error('Invite has invalid expiry timestamp');
    }

    if (expiryDate.getTime() <= Date.now()) {
      await this.prisma.$queryRaw`
        update public.org_invites
        set
          status = 'expired'::public.org_invite_status,
          responded_at = timezone('utc', now())
        where id = ${invite.id}::uuid
          and status = 'pending'::public.org_invite_status
      `;
      throw new Error('Invite has expired');
    }

    const invitedEmail = this.normalizeOptionalText(invite.invited_email)?.toLowerCase() ?? '';
    if (invitedEmail !== userEmail) {
      throw new Error('Invite email does not match current account');
    }

    const orgStatusRows = await this.prisma.$queryRaw<Array<{ org_status: string | null }>>`
      select coalesce(os.status::text, 'active') as org_status
      from public.organizations o
      left join public.org_status os on os.org_id = o.id
      where o.id = ${invite.org_id}::uuid
      limit 1
    `;
    const orgStatus =
      this.normalizeOptionalText(orgStatusRows[0]?.org_status)?.toLowerCase() ?? 'active';
    if (orgStatus !== 'active') {
      throw new Error('Organization is not active');
    }

    const membershipRows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      select true as exists
      from public.org_members om
      where om.org_id = ${invite.org_id}::uuid
        and om.user_id = ${userId}::uuid
        and om.status = 'active'
      limit 1
    `;
    if (membershipRows[0]?.exists) {
      throw new Error('You are already an active member of this organization');
    }

    await this.prisma.$queryRaw`
      insert into public.org_members (
        org_id,
        user_id,
        member_role,
        status,
        invited_by,
        joined_at
      )
      values (
        ${invite.org_id}::uuid,
        ${userId}::uuid,
        ${invite.member_role}::public.org_member_role,
        'active'::public.org_membership_status,
        ${invite.invited_by}::uuid,
        timezone('utc', now())
      )
      on conflict (org_id, user_id) do update
      set
        member_role = excluded.member_role,
        status = 'active'::public.org_membership_status,
        invited_by = excluded.invited_by,
        joined_at = excluded.joined_at,
        created_at = least(public.org_members.created_at, excluded.joined_at)
    `;

    await this.prisma.$queryRaw`
      update public.org_invites
      set
        status = 'accepted'::public.org_invite_status,
        accepted_by = ${userId}::uuid,
        responded_at = timezone('utc', now())
      where id = ${invite.id}::uuid
        and status = 'pending'::public.org_invite_status
    `;

    await this.invalidateWorkspaceBootstrapForOrg(invite.org_id);
    return invite.org_id;
  }
}
