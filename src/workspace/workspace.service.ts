import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ReadinessService } from '../readiness/readiness.service';
import { BillingService } from '../billing/billing.service';
import { CacheTelemetryService } from '../cache/cache-telemetry.service';
import { UpstashRedisCacheService } from '../cache/upstash-redis-cache.service';
import {
  WorkspaceBootstrapSnapshot,
  WorkspaceCoreTeamMember,
  WorkspaceCurrentPlanSnapshot,
  WorkspaceDashboardSnapshot,
  WorkspaceIdentitySnapshot,
  WorkspaceOrganizationReadinessSnapshot,
  WorkspaceSettingsSnapshot,
  WorkspaceStartupDiscoveryFeedItem,
  WorkspaceSnapshot,
} from './workspace.types';

type WorkspaceMembershipContext = {
  orgId: string;
  orgType: string;
  memberRole: string;
  activeOrgIds: string[];
};

type PrimaryWorkspaceMembership = {
  orgId: string;
  orgType: 'startup' | 'investor' | 'advisor';
  memberRole: 'owner' | 'admin' | 'member';
};

type WorkspaceIdentityMembershipRow = {
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
};

type WorkspaceBootstrapBaseRow = {
  profile_id: string;
  full_name: string | null;
  profile_location: string | null;
  bio: string | null;
  avatar_url: string | null;
  phone: string | null;
  headline: string | null;
  profile_website_url: string | null;
  profile_linkedin_url: string | null;
  timezone_name: string | null;
  preferred_contact_method: string | null;
  org_id: string | null;
  membership_user_id: string | null;
  member_role: string | null;
  membership_status: string | null;
  membership_created_at: string | Date | null;
  organization_id: string | null;
  organization_type: string | null;
  organization_name: string | null;
  organization_location: string | null;
  organization_logo_url: string | null;
  organization_industry_tags: string[] | null;
  organization_created_at: string | Date | null;
  verification_status: string | null;
  readiness_org_id: string | null;
  has_startup_post: boolean;
  has_pitch_deck: boolean;
  has_team_info: boolean;
  has_financial_doc: boolean;
  has_legal_doc: boolean;
  profile_completion_percent: number | string | null;
  readiness_score: number | string | null;
  required_docs_uploaded: boolean;
  eligible_for_discovery_post: boolean;
  is_ready: boolean;
  missing_steps: string[] | null;
  section_scores: unknown;
};

type CacheEmptySentinel = {
  __impactis_cache_empty__: true;
  reason: string;
  cached_at: string;
};

type WorkspaceCacheName = 'workspace_identity' | 'workspace_bootstrap' | 'workspace_settings';

type WorkspaceCacheMetricContext = {
  cacheName: WorkspaceCacheName;
  section?: WorkspaceSettingsSection | '';
};

const WORKSPACE_SETTINGS_SECTIONS = [
  'settings-identity',
  'settings-billing',
  'settings-startup-readiness',
  'settings-discovery',
  'settings-data-room',
  'settings-invites',
  'settings-permissions',
  'settings-team-access',
  'settings-readiness-rules',
] as const;

type WorkspaceSettingsSection = (typeof WORKSPACE_SETTINGS_SECTIONS)[number];

const WORKSPACE_SETTINGS_SECTION_SET = new Set<WorkspaceSettingsSection>(WORKSPACE_SETTINGS_SECTIONS);

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
    private readonly billing: BillingService,
    private readonly cache: UpstashRedisCacheService,
    private readonly cacheTelemetry: CacheTelemetryService,
    private readonly config: ConfigService,
  ) {}

  private normalizeOptionalText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeInteger(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return 0;
  }

  private normalizeNullableInteger(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.round(value);
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
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

  private normalizeIndustryTags(value: string[] | null | undefined): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized = value
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    return Array.from(new Set(normalized));
  }

  private normalizeSectionScores(
    value: unknown,
  ): Array<{
    section: string;
    weight: number;
    completion_percent: number;
    score_contribution: number;
  }> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return null;
        }

        const row = item as Record<string, unknown>;
        const section = this.normalizeOptionalText(
          typeof row.section === 'string' ? row.section : null,
        );
        if (!section) {
          return null;
        }

        return {
          section,
          weight: Math.max(0, this.normalizeInteger(row.weight)),
          completion_percent: Math.max(
            0,
            Math.min(100, this.normalizeInteger(row.completion_percent)),
          ),
          score_contribution: Math.max(
            0,
            Math.min(100, this.normalizeInteger(row.score_contribution)),
          ),
        };
      })
      .filter(
        (
          item,
        ): item is {
          section: string;
          weight: number;
          completion_percent: number;
          score_contribution: number;
        } => !!item,
      );
  }

  private normalizeOrgType(
    value: string | null | undefined,
  ): 'startup' | 'investor' | 'advisor' | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
    if (normalized === 'startup' || normalized === 'investor' || normalized === 'advisor') {
      return normalized;
    }

    return null;
  }

  private normalizeMemberRole(
    value: string | null | undefined,
  ): 'owner' | 'admin' | 'member' | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
    if (normalized === 'owner' || normalized === 'admin' || normalized === 'member') {
      return normalized;
    }

    return null;
  }

  private normalizeMembershipStatus(
    value: string | null | undefined,
  ): 'pending' | 'active' | 'left' | 'removed' | 'expired' | 'cancelled' | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
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

  private normalizePreferredContactMethod(
    value: string | null | undefined,
  ): 'email' | 'phone' | 'linkedin' | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
    if (normalized === 'email' || normalized === 'phone' || normalized === 'linkedin') {
      return normalized;
    }

    return null;
  }

  private normalizeWorkspaceSettingsSection(
    value: string | null | undefined,
  ): WorkspaceSettingsSection | '' {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase() ?? '';
    if (!normalized) {
      return '';
    }

    return WORKSPACE_SETTINGS_SECTION_SET.has(normalized as WorkspaceSettingsSection)
      ? (normalized as WorkspaceSettingsSection)
      : '';
  }

  private buildWorkspaceCacheTelemetryTags(
    context: WorkspaceCacheMetricContext,
    extras?: Record<string, string>,
  ): Record<string, string> {
    const tags: Record<string, string> = {
      cache_name: context.cacheName,
    };
    if (context.cacheName === 'workspace_settings') {
      tags.section = context.section || '_default';
    }

    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        tags[key] = value;
      }
    }

    return tags;
  }

  private getPositiveIntConfigValue(key: string, fallback: number): number {
    const rawValue = this.config.get<number>(key);
    if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 1) {
      return Math.trunc(rawValue);
    }

    return fallback;
  }

  private isCacheDebugEnabled(): boolean {
    const configValue = this.config.get<boolean>('cacheDebug');
    if (typeof configValue === 'boolean') {
      return configValue;
    }

    const rawValue = process.env.CACHE_DEBUG;
    if (typeof rawValue !== 'string') {
      return false;
    }

    const normalized = rawValue.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }

  private logCacheDebug(message: string): void {
    if (!this.isCacheDebugEnabled()) {
      return;
    }

    this.logger.log(`[cache] ${message}`);
  }

  private getCacheTtlJitterPercent(): number {
    const value = this.getPositiveIntConfigValue('cacheTtlJitterPercent', 15);
    return Math.min(50, Math.max(0, value));
  }

  private withTtlJitter(baseTtlSeconds: number): number {
    const safeBase = Math.max(1, Math.trunc(baseTtlSeconds));
    const jitterPercent = this.getCacheTtlJitterPercent();
    if (jitterPercent < 1) {
      return safeBase;
    }

    const jitterFactor = 1 - ((Math.random() * jitterPercent) / 100);
    return Math.max(1, Math.trunc(safeBase * jitterFactor));
  }

  private getWorkspaceBootstrapCacheTtlSeconds(): number {
    const base = this.getPositiveIntConfigValue('cacheWorkspaceBootstrapTtlSeconds', 300);
    return this.withTtlJitter(base);
  }

  private getWorkspaceIdentityCacheTtlSeconds(): number {
    const base = this.getPositiveIntConfigValue('cacheWorkspaceIdentityTtlSeconds', 300);
    return this.withTtlJitter(base);
  }

  private getWorkspaceSettingsCacheTtlSeconds(): number {
    const base = this.getPositiveIntConfigValue('cacheWorkspaceSettingsTtlSeconds', 300);
    return this.withTtlJitter(base);
  }

  private getWorkspaceEmptyCacheTtlSeconds(): number {
    const base = this.getPositiveIntConfigValue('cacheWorkspaceEmptyTtlSeconds', 30);
    return this.withTtlJitter(base);
  }

  private getCacheLockTtlSeconds(): number {
    return this.getPositiveIntConfigValue('cacheLockTtlSeconds', 5);
  }

  private getCacheLockWaitMs(): number {
    return this.getPositiveIntConfigValue('cacheLockWaitMs', 120);
  }

  private getCacheLockRetryAttempts(): number {
    return 2;
  }

  private isCacheEmptySentinel(value: unknown): value is CacheEmptySentinel {
    if (!value || typeof value !== 'object') {
      return false;
    }

    return (value as CacheEmptySentinel).__impactis_cache_empty__ === true;
  }

  private buildCacheEmptySentinel(reason: string): CacheEmptySentinel {
    return {
      __impactis_cache_empty__: true,
      reason,
      cached_at: new Date().toISOString(),
    };
  }

  private async readWorkspaceCache<T>(
    cacheKey: string,
    cacheLabel: string,
    context: WorkspaceCacheMetricContext,
  ): Promise<{ hit: boolean; value: T | null }> {
    const cached = await this.cache.getJson<T | CacheEmptySentinel>(cacheKey);
    if (!cached) {
      this.logCacheDebug(`${cacheLabel} cache miss`);
      this.cacheTelemetry.increment(
        'workspace.cache.read',
        this.buildWorkspaceCacheTelemetryTags(context, { result: 'miss' }),
      );
      return { hit: false, value: null };
    }

    if (this.isCacheEmptySentinel(cached)) {
      this.logCacheDebug(`${cacheLabel} cache hit-empty (${cached.reason})`);
      this.cacheTelemetry.increment(
        'workspace.cache.read',
        this.buildWorkspaceCacheTelemetryTags(context, { result: 'hit_empty' }),
      );
      return { hit: true, value: null };
    }

    this.logCacheDebug(`${cacheLabel} cache hit`);
    this.cacheTelemetry.increment(
      'workspace.cache.read',
      this.buildWorkspaceCacheTelemetryTags(context, { result: 'hit' }),
    );
    return { hit: true, value: cached as T };
  }

  private async writeWorkspaceCacheValue<T>(
    cacheKey: string,
    cacheLabel: string,
    value: T,
    ttlSeconds: number,
    context: WorkspaceCacheMetricContext,
  ): Promise<void> {
    await this.cache.setJson(cacheKey, value, ttlSeconds);
    this.logCacheDebug(`${cacheLabel} cache set ttl=${ttlSeconds}s`);
    this.cacheTelemetry.increment(
      'workspace.cache.write',
      this.buildWorkspaceCacheTelemetryTags(context, { kind: 'value' }),
    );
  }

  private async writeWorkspaceCacheEmpty(
    cacheKey: string,
    cacheLabel: string,
    reason: string,
    context: WorkspaceCacheMetricContext,
  ): Promise<void> {
    const ttlSeconds = this.getWorkspaceEmptyCacheTtlSeconds();
    await this.cache.setJson(
      cacheKey,
      this.buildCacheEmptySentinel(reason),
      ttlSeconds,
    );
    this.logCacheDebug(`${cacheLabel} cache set-empty reason=${reason} ttl=${ttlSeconds}s`);
    this.cacheTelemetry.increment(
      'workspace.cache.write',
      this.buildWorkspaceCacheTelemetryTags(context, { kind: 'empty' }),
    );
  }

  private async waitForWorkspaceCacheFill<T>(
    cacheKey: string,
    cacheLabel: string,
    context: WorkspaceCacheMetricContext,
  ): Promise<{ hit: boolean; value: T | null }> {
    const waitMs = this.getCacheLockWaitMs();
    const retries = this.getCacheLockRetryAttempts();

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const result = await this.readWorkspaceCache<T>(
        cacheKey,
        `${cacheLabel} wait-attempt=${attempt}`,
        context,
      );
      if (result.hit) {
        this.cacheTelemetry.increment(
          'workspace.cache.wait',
          this.buildWorkspaceCacheTelemetryTags(context, { result: 'hit' }),
        );
        return result;
      }
    }

    this.cacheTelemetry.increment(
      'workspace.cache.wait',
      this.buildWorkspaceCacheTelemetryTags(context, { result: 'miss' }),
    );
    return { hit: false, value: null };
  }

  private isMembershipRequiredError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : '';
    return message.toLowerCase().includes('organization membership is required');
  }

  private async resolveWorkspaceMembershipContext(userId: string): Promise<WorkspaceMembershipContext> {
    const membershipRows = await this.prisma.$queryRaw<
      Array<{
        org_id: string;
        org_type: string | null;
        member_role: string | null;
      }>
    >`
      select
        om.org_id,
        o.type::text as org_type,
        om.member_role::text as member_role
      from public.org_members om
      join public.organizations o on o.id = om.org_id
      left join public.org_status s on s.org_id = o.id
      where om.user_id = ${userId}::uuid
        and om.status = 'active'
        and coalesce(s.status::text, 'active') = 'active'
      order by om.created_at asc
      limit 1
    `;

    const membership = membershipRows[0];
    const orgType = this.normalizeOptionalText(membership?.org_type)?.toLowerCase() ?? null;
    const memberRole = this.normalizeOptionalText(membership?.member_role)?.toLowerCase() ?? null;
    if (!membership?.org_id || !orgType || !memberRole) {
      throw new Error('Organization membership is required');
    }

    const activeOrgRows = await this.prisma.$queryRaw<Array<{ org_id: string }>>`
      select om.org_id
      from public.org_members om
      where om.user_id = ${userId}::uuid
        and om.status = 'active'
    `;

    return {
      orgId: membership.org_id,
      orgType,
      memberRole,
      activeOrgIds: activeOrgRows.map((row) => row.org_id),
    };
  }

  private async getPrimaryMembershipDetailsForUser(
    userId: string,
  ): Promise<WorkspaceIdentityMembershipRow | null> {
    const rows = await this.prisma.$queryRaw<Array<WorkspaceIdentityMembershipRow>>`
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
      left join public.org_status s on s.org_id = o.id
      where om.user_id = ${userId}::uuid
        and om.status = 'active'
        and coalesce(s.status::text, 'active') = 'active'
      order by om.created_at asc
      limit 1
    `;

    return rows[0] ?? null;
  }

  private async resolvePrimaryWorkspaceMembershipForUser(
    userId: string,
  ): Promise<PrimaryWorkspaceMembership> {
    const membership = await this.getPrimaryMembershipDetailsForUser(userId);
    const orgType = this.normalizeOrgType(membership?.organization_type);
    const memberRole = this.normalizeMemberRole(membership?.member_role);
    if (!membership?.org_id || !orgType || !memberRole) {
      throw new Error('Organization membership is required');
    }

    return {
      orgId: membership.org_id,
      orgType,
      memberRole,
    };
  }

  private async readWorkspaceBootstrapCacheFast(userId: string): Promise<WorkspaceBootstrapSnapshot | null> {
    const cacheKey = this.cache.workspaceBootstrapKey(userId);
    const cached = await this.cache.getJson<WorkspaceBootstrapSnapshot | CacheEmptySentinel>(cacheKey);
    if (!cached || this.isCacheEmptySentinel(cached)) {
      return null;
    }

    return cached as WorkspaceBootstrapSnapshot;
  }

  private toPrimaryWorkspaceMembershipFromBootstrap(
    bootstrap: WorkspaceBootstrapSnapshot,
  ): PrimaryWorkspaceMembership | null {
    if (!bootstrap.membership) {
      return null;
    }

    return {
      orgId: bootstrap.membership.org_id,
      orgType: bootstrap.membership.organization.type,
      memberRole: bootstrap.membership.member_role,
    };
  }

  private buildWorkspaceIdentityFromBootstrap(
    userId: string,
    bootstrap: WorkspaceBootstrapSnapshot,
  ): WorkspaceIdentitySnapshot {
    return {
      profile: {
        ...bootstrap.profile,
        id: bootstrap.profile.id || userId,
      },
      membership: bootstrap.membership
        ? {
            ...bootstrap.membership,
            organization: {
              ...bootstrap.membership.organization,
              industry_tags: [...bootstrap.membership.organization.industry_tags],
            },
          }
        : null,
    };
  }

  private async getVerificationStatus(orgId: string): Promise<string> {
    const verificationRows = await this.prisma.$queryRaw<Array<{ status: string | null }>>`
      select ov.status::text as status
      from public.org_verifications ov
      where ov.org_id = ${orgId}::uuid
      limit 1
    `;

    return this.normalizeOptionalText(verificationRows[0]?.status)?.toLowerCase() ?? 'unverified';
  }

  private async getStartupReadinessForOrg(orgId: string): Promise<WorkspaceSnapshot['startup_readiness']> {
    return this.readiness.getStartupReadinessForOrg(orgId);
  }

  private normalizeStartupVerificationStatus(
    value: string | null | undefined,
  ): WorkspaceStartupDiscoveryFeedItem['startup_verification_status'] {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
    if (
      normalized === 'approved'
      || normalized === 'pending'
      || normalized === 'rejected'
      || normalized === 'unverified'
    ) {
      return normalized;
    }

    return 'unverified';
  }

  private async getOrganizationReadinessForOrg(
    orgId: string,
  ): Promise<WorkspaceOrganizationReadinessSnapshot | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        org_id: string;
        org_type: string | null;
        readiness_score: number | string | null;
        is_ready: boolean;
        missing_steps: string[] | null;
        rules_version: string | null;
        computed_at: string | Date | null;
      }>
    >`
      select
        ors.org_id,
        ors.org_type::text as org_type,
        coalesce(ors.readiness_score, 0)::integer as readiness_score,
        coalesce(ors.is_ready, false) as is_ready,
        coalesce(ors.missing_steps, '{}'::text[]) as missing_steps,
        coalesce(ors.rules_version, 'unknown') as rules_version,
        ors.computed_at
      from public.organization_readiness_summary_v1 ors
      where ors.org_id = ${orgId}::uuid
      limit 1
    `;

    const row = rows[0];
    const orgType = this.normalizeOrgType(row?.org_type);
    if (!row?.org_id || !orgType) {
      return null;
    }

    return {
      org_id: row.org_id,
      org_type: orgType,
      readiness_score: Math.max(0, Math.min(100, this.normalizeInteger(row.readiness_score))),
      is_ready: row.is_ready === true,
      missing_steps: Array.isArray(row.missing_steps) ? row.missing_steps : [],
      rules_version: this.normalizeOptionalText(row.rules_version) ?? 'unknown',
      computed_at: this.normalizeTimestamp(row.computed_at),
    };
  }

  private async listStartupDiscoveryFeedForInvestorOrAdvisor(): Promise<WorkspaceStartupDiscoveryFeedItem[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        startup_org_id: string;
        startup_org_name: string;
        title: string;
        summary: string;
        stage: string | null;
        location: string | null;
        industry_tags: string[] | null;
        published_at: string | Date | null;
        startup_verification_status: string | null;
      }>
    >`
      select
        sp.id::text as id,
        sp.startup_org_id::text as startup_org_id,
        o.name as startup_org_name,
        sp.title,
        sp.summary,
        nullif(trim(coalesce(sp.stage, '')), '') as stage,
        nullif(trim(coalesce(sp.location, '')), '') as location,
        coalesce(sp.industry_tags, '{}'::text[]) as industry_tags,
        sp.published_at,
        coalesce(v.status::text, 'unverified') as startup_verification_status
      from public.startup_posts sp
      join public.organizations o on o.id = sp.startup_org_id
      left join public.org_status s on s.org_id = o.id
      left join public.org_verifications v on v.org_id = o.id
      where sp.status = 'published'::public.startup_post_status
        and o.type = 'startup'::public.org_type
        and coalesce(s.status::text, 'active') = 'active'
      order by coalesce(sp.published_at, sp.updated_at) desc, sp.created_at desc
      limit 120
    `;

    return rows
      .map((row): WorkspaceStartupDiscoveryFeedItem | null => {
        if (!row?.id || !row.startup_org_id || !row.startup_org_name || !row.title || !row.summary) {
          return null;
        }

        return {
          id: row.id,
          startup_org_id: row.startup_org_id,
          startup_org_name: row.startup_org_name,
          title: row.title,
          summary: row.summary,
          stage: this.normalizeOptionalText(row.stage),
          location: this.normalizeOptionalText(row.location),
          industry_tags: this.normalizeIndustryTags(row.industry_tags),
          published_at: this.normalizeTimestamp(row.published_at),
          startup_verification_status: this.normalizeStartupVerificationStatus(
            row.startup_verification_status,
          ),
        };
      })
      .filter((row): row is WorkspaceStartupDiscoveryFeedItem => !!row);
  }

  private async getCurrentPlanForOrg(orgId: string): Promise<WorkspaceCurrentPlanSnapshot | null> {
    return this.billing.getCurrentPlanForOrg(orgId);
  }

  private async getStartupProfileForOrg(
    orgId: string,
  ): Promise<WorkspaceSettingsSnapshot['startup_profile']> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        startup_org_id: string;
        website_url: string | null;
        pitch_deck_url: string | null;
        pitch_deck_media_kind: string | null;
        pitch_deck_file_name: string | null;
        pitch_deck_file_size_bytes: number | string | null;
        team_overview: string | null;
        company_stage: string | null;
        founding_year: number | string | null;
        team_size: number | string | null;
        target_market: string | null;
        business_model: string | null;
        traction_summary: string | null;
        financial_summary: string | null;
        legal_summary: string | null;
        financial_doc_url: string | null;
        financial_doc_file_name: string | null;
        financial_doc_file_size_bytes: number | string | null;
        legal_doc_url: string | null;
        legal_doc_file_name: string | null;
        legal_doc_file_size_bytes: number | string | null;
        updated_at: string | Date | null;
      }>
    >`
      select
        o.id as startup_org_id,
        nullif(trim(coalesce(sp.website_url, '')), '') as website_url,
        nullif(trim(coalesce(sp.pitch_deck_url, '')), '') as pitch_deck_url,
        case
          when sp.pitch_deck_media_kind in ('document', 'video')
            then sp.pitch_deck_media_kind::text
          else null
        end as pitch_deck_media_kind,
        nullif(trim(coalesce(sp.pitch_deck_file_name, '')), '') as pitch_deck_file_name,
        sp.pitch_deck_file_size_bytes,
        nullif(trim(coalesce(sp.team_overview, '')), '') as team_overview,
        nullif(trim(coalesce(sp.company_stage, '')), '') as company_stage,
        sp.founding_year,
        sp.team_size,
        nullif(trim(coalesce(sp.target_market, '')), '') as target_market,
        nullif(trim(coalesce(sp.business_model, '')), '') as business_model,
        nullif(trim(coalesce(sp.traction_summary, '')), '') as traction_summary,
        nullif(trim(coalesce(sp.financial_summary, '')), '') as financial_summary,
        nullif(trim(coalesce(sp.legal_summary, '')), '') as legal_summary,
        nullif(trim(coalesce(sp.financial_doc_url, '')), '') as financial_doc_url,
        nullif(trim(coalesce(sp.financial_doc_file_name, '')), '') as financial_doc_file_name,
        sp.financial_doc_file_size_bytes,
        nullif(trim(coalesce(sp.legal_doc_url, '')), '') as legal_doc_url,
        nullif(trim(coalesce(sp.legal_doc_file_name, '')), '') as legal_doc_file_name,
        sp.legal_doc_file_size_bytes,
        sp.updated_at
      from public.organizations o
      left join public.startup_profiles sp on sp.startup_org_id = o.id
      where o.id = ${orgId}::uuid
        and o.type = 'startup'::public.org_type
      limit 1
    `;

    const row = rows[0];
    if (!row?.startup_org_id) {
      return null;
    }

    return {
      startup_org_id: row.startup_org_id,
      website_url: row.website_url,
      pitch_deck_url: row.pitch_deck_url,
      pitch_deck_media_kind: row.pitch_deck_media_kind,
      pitch_deck_file_name: row.pitch_deck_file_name,
      pitch_deck_file_size_bytes: this.normalizeNullableInteger(row.pitch_deck_file_size_bytes),
      team_overview: row.team_overview,
      company_stage: row.company_stage,
      founding_year: this.normalizeNullableInteger(row.founding_year),
      team_size: this.normalizeNullableInteger(row.team_size),
      target_market: row.target_market,
      business_model: row.business_model,
      traction_summary: row.traction_summary,
      financial_summary: row.financial_summary,
      legal_summary: row.legal_summary,
      financial_doc_url: row.financial_doc_url,
      financial_doc_file_name: row.financial_doc_file_name,
      financial_doc_file_size_bytes: this.normalizeNullableInteger(row.financial_doc_file_size_bytes),
      legal_doc_url: row.legal_doc_url,
      legal_doc_file_name: row.legal_doc_file_name,
      legal_doc_file_size_bytes: this.normalizeNullableInteger(row.legal_doc_file_size_bytes),
      updated_at: this.normalizeTimestamp(row.updated_at),
    };
  }

  private async getStartupPostForOrg(
    orgId: string,
  ): Promise<WorkspaceSettingsSnapshot['startup_post']> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        startup_org_id: string;
        title: string;
        summary: string;
        stage: string | null;
        location: string | null;
        industry_tags: string[] | null;
        status: string | null;
        published_at: string | Date | null;
        updated_at: string | Date | null;
      }>
    >`
      select
        sp.id,
        sp.startup_org_id,
        sp.title,
        sp.summary,
        nullif(trim(coalesce(sp.stage, '')), '') as stage,
        nullif(trim(coalesce(sp.location, '')), '') as location,
        coalesce(sp.industry_tags, '{}'::text[]) as industry_tags,
        sp.status::text as status,
        sp.published_at,
        sp.updated_at
      from public.startup_posts sp
      where sp.startup_org_id = ${orgId}::uuid
      limit 1
    `;

    const row = rows[0];
    const updatedAt = this.normalizeTimestamp(row?.updated_at);
    if (!row?.id || !row.startup_org_id || !row.title || !row.summary || !row.status || !updatedAt) {
      return null;
    }

    return {
      id: row.id,
      startup_org_id: row.startup_org_id,
      title: row.title,
      summary: row.summary,
      stage: row.stage,
      location: row.location,
      industry_tags: this.normalizeIndustryTags(row.industry_tags),
      status: row.status,
      published_at: this.normalizeTimestamp(row.published_at),
      updated_at: updatedAt,
    };
  }

  async getWorkspaceIdentityForUser(userId: string): Promise<WorkspaceIdentitySnapshot> {
    const cacheKey = this.cache.workspaceIdentityKey(userId);
    const cacheLabel = `workspace-identity user=${userId}`;
    const metricContext: WorkspaceCacheMetricContext = {
      cacheName: 'workspace_identity',
    };
    const cached = await this.readWorkspaceCache<WorkspaceIdentitySnapshot>(
      cacheKey,
      cacheLabel,
      metricContext,
    );
    if (cached.hit && cached.value) {
      return cached.value;
    }

    if (this.cache.isRemoteCacheEnabled()) {
      const lockKey = this.cache.cacheFillLockKey(cacheKey);
      const hasLock = await this.cache.tryAcquireLock(lockKey, this.getCacheLockTtlSeconds());
      this.cacheTelemetry.increment(
        'workspace.cache.lock',
        this.buildWorkspaceCacheTelemetryTags(metricContext, {
          result: hasLock ? 'acquired' : 'contended',
        }),
      );
      if (!hasLock) {
        this.logCacheDebug(`${cacheLabel} lock busy, waiting for cache fill`);
        const waited = await this.waitForWorkspaceCacheFill<WorkspaceIdentitySnapshot>(
          cacheKey,
          cacheLabel,
          metricContext,
        );
        if (waited.hit && waited.value) {
          return waited.value;
        }
      }
    }

    const bootstrapCached = await this.readWorkspaceBootstrapCacheFast(userId);
    if (bootstrapCached) {
      const payload = this.buildWorkspaceIdentityFromBootstrap(userId, bootstrapCached);
      await this.writeWorkspaceCacheValue(
        cacheKey,
        cacheLabel,
        payload,
        this.getWorkspaceIdentityCacheTtlSeconds(),
        metricContext,
      );
      return payload;
    }

    const [profileRows, membershipRow] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          id: string;
          full_name: string | null;
          location: string | null;
          bio: string | null;
          avatar_url: string | null;
          phone: string | null;
          headline: string | null;
          website_url: string | null;
          linkedin_url: string | null;
          timezone_name: string | null;
          preferred_contact_method: string | null;
        }>
      >`
        select
          p.id,
          p.full_name,
          p.location,
          p.bio,
          p.avatar_url,
          p.phone,
          p.headline,
          p.website_url,
          p.linkedin_url,
          p.timezone_name,
          p.preferred_contact_method
        from public.profiles p
        where p.id = ${userId}::uuid
        limit 1
      `,
      this.getPrimaryMembershipDetailsForUser(userId),
    ]);

    const profile = profileRows[0];
    const profilePayload: WorkspaceIdentitySnapshot['profile'] = {
      id: userId,
      full_name: profile?.full_name ?? null,
      location: profile?.location ?? null,
      bio: profile?.bio ?? null,
      avatar_url: profile?.avatar_url ?? null,
      phone: profile?.phone ?? null,
      headline: profile?.headline ?? null,
      website_url: profile?.website_url ?? null,
      linkedin_url: profile?.linkedin_url ?? null,
      timezone_name: profile?.timezone_name ?? null,
      preferred_contact_method: this.normalizePreferredContactMethod(
        profile?.preferred_contact_method ?? null,
      ),
    };

    let payload: WorkspaceIdentitySnapshot;
    if (!membershipRow) {
      payload = {
        profile: profilePayload,
        membership: null,
      };
    } else {
      const memberRole = this.normalizeMemberRole(membershipRow.member_role);
      const membershipStatus = this.normalizeMembershipStatus(membershipRow.status);
      const organizationType = this.normalizeOrgType(membershipRow.organization_type);
      const membershipCreatedAt = this.normalizeTimestamp(membershipRow.created_at);
      const organizationCreatedAt = this.normalizeTimestamp(membershipRow.organization_created_at);

      const hasValidMembership =
        !!memberRole
        && !!membershipStatus
        && !!organizationType
        && !!membershipCreatedAt
        && !!organizationCreatedAt;

      payload = hasValidMembership
        ? {
            profile: profilePayload,
            membership: {
              org_id: membershipRow.org_id,
              user_id: membershipRow.user_id,
              member_role: memberRole,
              status: membershipStatus,
              created_at: membershipCreatedAt,
              organization: {
                id: membershipRow.organization_id,
                type: organizationType,
                name: membershipRow.organization_name,
                location: membershipRow.organization_location,
                logo_url: membershipRow.organization_logo_url,
                industry_tags: this.normalizeIndustryTags(membershipRow.organization_industry_tags),
                created_at: organizationCreatedAt,
              },
            },
          }
        : {
            profile: profilePayload,
            membership: null,
          };
    }

    await this.writeWorkspaceCacheValue(
      cacheKey,
      cacheLabel,
      payload,
      this.getWorkspaceIdentityCacheTtlSeconds(),
      metricContext,
    );
    return payload;
  }

  private async listOrganizationCoreTeamForOrg(
    orgId: string,
  ): Promise<WorkspaceCoreTeamMember[]> {
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
      where om.org_id = ${orgId}::uuid
        and om.status = 'active'
      order by om.created_at asc
    `;

    return rows
      .map((row): WorkspaceCoreTeamMember | null => {
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
          full_name: this.normalizeOptionalText(row.full_name),
          avatar_url: this.normalizeOptionalText(row.avatar_url),
          location: this.normalizeOptionalText(row.location),
        };
      })
      .filter((row): row is WorkspaceCoreTeamMember => !!row);
  }

  async listOrganizationCoreTeamForUser(
    userId: string,
    orgIdInput?: string | null,
  ): Promise<WorkspaceCoreTeamMember[]> {
    const requestedOrgId = this.normalizeOptionalText(orgIdInput);
    const membership = await this.getPrimaryMembershipDetailsForUser(userId);
    const targetOrgId = requestedOrgId ?? membership?.org_id ?? null;

    if (!targetOrgId) {
      return [];
    }

    const accessRows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      select true as exists
      from public.org_members om
      where om.org_id = ${targetOrgId}::uuid
        and om.user_id = ${userId}::uuid
        and om.status = 'active'
      limit 1
    `;
    if (!accessRows[0]?.exists) {
      return [];
    }

    return this.listOrganizationCoreTeamForOrg(targetOrgId);
  }

  async getWorkspaceDashboardSnapshotForUser(
    userId: string,
  ): Promise<WorkspaceDashboardSnapshot | null> {
    try {
      const membership = await this.resolvePrimaryWorkspaceMembershipForUser(userId);
      const [verificationStatus, currentPlan, organizationCoreTeam, startupReadiness, organizationReadiness, startupDiscoveryFeed] = await Promise.all([
        this.getVerificationStatus(membership.orgId),
        this.getCurrentPlanForOrg(membership.orgId),
        this.listOrganizationCoreTeamForOrg(membership.orgId),
        membership.orgType === 'startup'
          ? this.getStartupReadinessForOrg(membership.orgId)
          : Promise.resolve(null),
        this.getOrganizationReadinessForOrg(membership.orgId),
        membership.orgType === 'investor' || membership.orgType === 'advisor'
          ? this.listStartupDiscoveryFeedForInvestorOrAdvisor()
          : Promise.resolve([]),
      ]);

      return {
        verification_status: verificationStatus,
        current_plan: currentPlan,
        organization_core_team: organizationCoreTeam,
        organization_readiness: organizationReadiness,
        startup_discovery_feed: startupDiscoveryFeed,
        startup_readiness: startupReadiness,
      };
    } catch {
      return null;
    }
  }

  async getWorkspaceBootstrapSnapshotForUser(
    userId: string,
  ): Promise<WorkspaceBootstrapSnapshot | null> {
    const cacheKey = this.cache.workspaceBootstrapKey(userId);
    const cacheLabel = `workspace-bootstrap user=${userId}`;
    const metricContext: WorkspaceCacheMetricContext = {
      cacheName: 'workspace_bootstrap',
    };
    const cached = await this.readWorkspaceCache<WorkspaceBootstrapSnapshot>(
      cacheKey,
      cacheLabel,
      metricContext,
    );
    if (cached.hit) {
      if (!cached.value) {
        return null;
      }

      return {
        ...cached.value,
        current_plan: cached.value.current_plan ?? null,
      };
    }

    if (this.cache.isRemoteCacheEnabled()) {
      const lockKey = this.cache.cacheFillLockKey(cacheKey);
      const hasLock = await this.cache.tryAcquireLock(lockKey, this.getCacheLockTtlSeconds());
      this.cacheTelemetry.increment(
        'workspace.cache.lock',
        this.buildWorkspaceCacheTelemetryTags(metricContext, {
          result: hasLock ? 'acquired' : 'contended',
        }),
      );
      if (!hasLock) {
        this.logCacheDebug(`${cacheLabel} lock busy, waiting for cache fill`);
        const waited = await this.waitForWorkspaceCacheFill<WorkspaceBootstrapSnapshot>(
          cacheKey,
          cacheLabel,
          metricContext,
        );
        if (waited.hit) {
          if (!waited.value) {
            return null;
          }

          return {
            ...waited.value,
            current_plan: waited.value.current_plan ?? null,
          };
        }
      }
    }

    try {
      const rows = await this.prisma.$queryRaw<Array<WorkspaceBootstrapBaseRow>>`
        with input as (
          select ${userId}::uuid as user_id
        )
        select
          i.user_id::text as profile_id,
          p.full_name,
          p.location as profile_location,
          p.bio,
          p.avatar_url,
          p.phone,
          p.headline,
          p.website_url as profile_website_url,
          p.linkedin_url as profile_linkedin_url,
          p.timezone_name,
          p.preferred_contact_method,
          m.org_id,
          m.user_id::text as membership_user_id,
          m.member_role::text as member_role,
          m.status::text as membership_status,
          m.created_at as membership_created_at,
          o.id::text as organization_id,
          o.type::text as organization_type,
          o.name as organization_name,
          o.location as organization_location,
          o.logo_url as organization_logo_url,
          o.industry_tags as organization_industry_tags,
          o.created_at as organization_created_at,
          coalesce(ov.status::text, 'unverified') as verification_status,
          sr.org_id::text as readiness_org_id,
          coalesce(sr.has_startup_post, false) as has_startup_post,
          coalesce(sr.has_pitch_deck, false) as has_pitch_deck,
          coalesce(sr.has_team_info, false) as has_team_info,
          coalesce(sr.has_financial_doc, false) as has_financial_doc,
          coalesce(sr.has_legal_doc, false) as has_legal_doc,
          coalesce(sr.profile_completion_percent, 0)::integer as profile_completion_percent,
          coalesce(sr.readiness_score, 0)::integer as readiness_score,
          coalesce(sr.required_docs_uploaded, false) as required_docs_uploaded,
          coalesce(sr.eligible_for_discovery_post, false) as eligible_for_discovery_post,
          coalesce(sr.is_ready, false) as is_ready,
          coalesce(sr.missing_steps, '{}'::text[]) as missing_steps,
          coalesce(sr.section_scores, '[]'::jsonb) as section_scores
        from input i
        left join public.profiles p on p.id = i.user_id
        left join lateral (
          select
            om.org_id,
            om.user_id,
            om.member_role,
            om.status,
            om.created_at
          from public.org_members om
          left join public.org_status os on os.org_id = om.org_id
          where om.user_id = i.user_id
            and om.status = 'active'
            and coalesce(os.status::text, 'active') = 'active'
          order by om.created_at asc
          limit 1
        ) m on true
        left join public.organizations o on o.id = m.org_id
        left join public.org_verifications ov on ov.org_id = o.id
        left join public.startup_readiness_v2 sr
          on sr.org_id = o.id
          and o.type = 'startup'::public.org_type
        limit 1
      `;

      const row = rows[0];
      if (!row) {
        await this.writeWorkspaceCacheEmpty(
          cacheKey,
          cacheLabel,
          'bootstrap-row-not-found',
          metricContext,
        );
        return null;
      }

      const profilePayload: WorkspaceBootstrapSnapshot['profile'] = {
        id: row.profile_id ?? userId,
        full_name: this.normalizeOptionalText(row.full_name),
        location: this.normalizeOptionalText(row.profile_location),
        bio: this.normalizeOptionalText(row.bio),
        avatar_url: this.normalizeOptionalText(row.avatar_url),
        phone: this.normalizeOptionalText(row.phone),
        headline: this.normalizeOptionalText(row.headline),
        website_url: this.normalizeOptionalText(row.profile_website_url),
        linkedin_url: this.normalizeOptionalText(row.profile_linkedin_url),
        timezone_name: this.normalizeOptionalText(row.timezone_name),
        preferred_contact_method: this.normalizePreferredContactMethod(
          row.preferred_contact_method,
        ),
      };

      const memberRole = this.normalizeMemberRole(row.member_role);
      const membershipStatus = this.normalizeMembershipStatus(row.membership_status);
      const organizationType = this.normalizeOrgType(row.organization_type);
      const membershipCreatedAt = this.normalizeTimestamp(row.membership_created_at);
      const organizationCreatedAt = this.normalizeTimestamp(row.organization_created_at);

      const hasValidMembership =
        !!row.org_id
        && !!row.membership_user_id
        && !!row.organization_id
        && !!row.organization_name
        && !!memberRole
        && !!membershipStatus
        && !!organizationType
        && !!membershipCreatedAt
        && !!organizationCreatedAt;

      if (!hasValidMembership) {
        const payload: WorkspaceBootstrapSnapshot = {
          profile: profilePayload,
          membership: null,
          verification_status: 'unverified',
          current_plan: null,
          organization_core_team: [],
          organization_readiness: null,
          startup_discovery_feed: [],
          startup_readiness: null,
        };

        await this.writeWorkspaceCacheValue(
          cacheKey,
          cacheLabel,
          payload,
          this.getWorkspaceBootstrapCacheTtlSeconds(),
          metricContext,
        );
        return payload;
      }

      const membership: WorkspaceBootstrapSnapshot['membership'] = {
        org_id: row.org_id as string,
        user_id: row.membership_user_id as string,
        member_role: memberRole as 'owner' | 'admin' | 'member',
        status: membershipStatus as 'pending' | 'active' | 'left' | 'removed' | 'expired' | 'cancelled',
        created_at: membershipCreatedAt as string,
        organization: {
          id: row.organization_id as string,
          type: organizationType as 'startup' | 'investor' | 'advisor',
          name: row.organization_name as string,
          location: this.normalizeOptionalText(row.organization_location),
          logo_url: this.normalizeOptionalText(row.organization_logo_url),
          industry_tags: this.normalizeIndustryTags(row.organization_industry_tags),
          created_at: organizationCreatedAt as string,
        },
      };

      const [organizationCoreTeam, currentPlan, startupReadiness, organizationReadiness, startupDiscoveryFeed] = await Promise.all([
        this.listOrganizationCoreTeamForOrg(membership.org_id),
        this.getCurrentPlanForOrg(membership.org_id),
        membership.organization.type === 'startup' && row.readiness_org_id
          ? Promise.resolve({
              startup_org_id: row.readiness_org_id,
              has_startup_post: row.has_startup_post === true,
              has_pitch_deck: row.has_pitch_deck === true,
              has_team_info: row.has_team_info === true,
              has_financial_doc: row.has_financial_doc === true,
              has_legal_doc: row.has_legal_doc === true,
              profile_completion_percent: Math.max(
                0,
                Math.min(100, this.normalizeInteger(row.profile_completion_percent)),
              ),
              readiness_score: Math.max(0, Math.min(100, this.normalizeInteger(row.readiness_score))),
              required_docs_uploaded: row.required_docs_uploaded === true,
              eligible_for_discovery_post: row.eligible_for_discovery_post === true,
              is_ready: row.is_ready === true,
              missing_steps: Array.isArray(row.missing_steps) ? row.missing_steps : [],
              section_scores: this.normalizeSectionScores(row.section_scores),
            })
          : Promise.resolve(null),
        this.getOrganizationReadinessForOrg(membership.org_id),
        membership.organization.type === 'investor' || membership.organization.type === 'advisor'
          ? this.listStartupDiscoveryFeedForInvestorOrAdvisor()
          : Promise.resolve([]),
      ]);

      const payload: WorkspaceBootstrapSnapshot = {
        profile: profilePayload,
        membership,
        verification_status: this.normalizeOptionalText(row.verification_status)?.toLowerCase() ?? 'unverified',
        current_plan: currentPlan,
        organization_core_team: organizationCoreTeam,
        organization_readiness: organizationReadiness,
        startup_discovery_feed: startupDiscoveryFeed,
        startup_readiness: startupReadiness,
      };

      await this.writeWorkspaceCacheValue(
        cacheKey,
        cacheLabel,
        payload,
        this.getWorkspaceBootstrapCacheTtlSeconds(),
        metricContext,
      );
      await this.writeWorkspaceCacheValue(
        this.cache.workspaceIdentityKey(userId),
        `workspace-identity user=${userId} prewarm`,
        this.buildWorkspaceIdentityFromBootstrap(userId, payload),
        this.getWorkspaceIdentityCacheTtlSeconds(),
        { cacheName: 'workspace_identity' },
      );
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logCacheDebug(`${cacheLabel} db fetch failed: ${message}`);
      return null;
    }
  }

  async getWorkspaceSnapshotForUser(userId: string): Promise<WorkspaceSnapshot | null> {
    try {
      const membership = await this.resolveWorkspaceMembershipContext(userId);
      const [verificationStatus, currentPlan] = await Promise.all([
        this.getVerificationStatus(membership.orgId),
        this.getCurrentPlanForOrg(membership.orgId),
      ]);

      let advisorDirectory: WorkspaceSnapshot['advisor_directory'] = [];
      let startupReadiness: WorkspaceSnapshot['startup_readiness'] = null;
      if (membership.orgType === 'startup') {
        const advisorRows = await this.prisma.$queryRaw<
          Array<{
            id: string;
            name: string;
            location: string | null;
            industry_tags: string[] | null;
            verification_status: string | null;
          }>
        >`
          select
            o.id,
            o.name,
            o.location,
            o.industry_tags,
            coalesce(v.status::text, 'unverified') as verification_status
          from public.organizations o
          left join public.org_verifications v on v.org_id = o.id
          left join public.org_status s on s.org_id = o.id
          where o.type = 'advisor'::public.org_type
            and coalesce(s.status::text, 'active') = 'active'
          order by o.created_at desc
        `;

        advisorDirectory = advisorRows.map((row) => ({
          id: row.id,
          name: row.name,
          location: row.location,
          industry_tags: this.normalizeIndustryTags(row.industry_tags),
          verification_status: this.normalizeOptionalText(row.verification_status) ?? 'unverified',
        }));

        startupReadiness = await this.getStartupReadinessForOrg(membership.orgId);
      }

      return {
        verification_status: verificationStatus,
        current_plan: currentPlan,
        advisor_directory: advisorDirectory,
        startup_readiness: startupReadiness,
      };
    } catch {
      return null;
    }
  }

  async getWorkspaceSettingsSnapshotForUser(
    userId: string,
    sectionInput?: string | null,
  ): Promise<WorkspaceSettingsSnapshot | null> {
    const section = this.normalizeWorkspaceSettingsSection(sectionInput);
    const cacheKey = this.cache.workspaceSettingsSnapshotKey(userId, section || null);
    const sectionLabel = section || '_default';
    const cacheLabel = `workspace-settings user=${userId} section=${sectionLabel}`;
    const metricContext: WorkspaceCacheMetricContext = {
      cacheName: 'workspace_settings',
      section,
    };
    const cached = await this.readWorkspaceCache<WorkspaceSettingsSnapshot>(
      cacheKey,
      cacheLabel,
      metricContext,
    );
    if (cached.hit) {
      if (!cached.value) {
        return null;
      }

      return {
        ...cached.value,
        current_plan: cached.value.current_plan ?? null,
      };
    }

    if (this.cache.isRemoteCacheEnabled()) {
      const lockKey = this.cache.cacheFillLockKey(cacheKey);
      const hasLock = await this.cache.tryAcquireLock(lockKey, this.getCacheLockTtlSeconds());
      this.cacheTelemetry.increment(
        'workspace.cache.lock',
        this.buildWorkspaceCacheTelemetryTags(metricContext, {
          result: hasLock ? 'acquired' : 'contended',
        }),
      );
      if (!hasLock) {
        this.logCacheDebug(`${cacheLabel} lock busy, waiting for cache fill`);
        const waited = await this.waitForWorkspaceCacheFill<WorkspaceSettingsSnapshot>(
          cacheKey,
          cacheLabel,
          metricContext,
        );
        if (waited.hit) {
          if (!waited.value) {
            return null;
          }

          return {
            ...waited.value,
            current_plan: waited.value.current_plan ?? null,
          };
        }
      }
    }

    const bootstrapCached = await this.readWorkspaceBootstrapCacheFast(userId);

    try {
      const bootstrapMembership = bootstrapCached
        ? this.toPrimaryWorkspaceMembershipFromBootstrap(bootstrapCached)
        : null;
      const membership = bootstrapMembership ?? await this.resolvePrimaryWorkspaceMembershipForUser(userId);
      const verificationStatus =
        bootstrapCached?.membership?.org_id === membership.orgId
          ? (this.normalizeOptionalText(bootstrapCached.verification_status)?.toLowerCase() ?? 'unverified')
          : await this.getVerificationStatus(membership.orgId);
      const currentPlan =
        bootstrapCached?.membership?.org_id === membership.orgId
          ? (bootstrapCached.current_plan ?? null)
          : await this.getCurrentPlanForOrg(membership.orgId);

      let pendingInvitesCount = 0;
      let pendingInvites: WorkspaceSettingsSnapshot['pending_invites'] = [];
      if (membership.memberRole === 'owner') {
        if (section === 'settings-invites') {
          const inviteRows = await this.prisma.$queryRaw<
            Array<{
              id: string;
              org_id: string;
              invited_email: string;
              member_role: string;
              status: string;
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
            where oi.org_id = ${membership.orgId}::uuid
              and oi.status = 'pending'::public.org_invite_status
            order by oi.created_at desc
          `;

          pendingInvites = inviteRows
            .map((row) => {
              const expiresAt = this.normalizeTimestamp(row.expires_at);
              const createdAt = this.normalizeTimestamp(row.created_at);
              if (!expiresAt || !createdAt) {
                return null;
              }

              return {
                id: row.id,
                org_id: row.org_id,
                invited_email: row.invited_email,
                member_role: row.member_role,
                status: row.status,
                invited_by: row.invited_by,
                accepted_by: row.accepted_by,
                expires_at: expiresAt,
                created_at: createdAt,
                responded_at: this.normalizeTimestamp(row.responded_at),
              };
            })
            .filter((row): row is WorkspaceSettingsSnapshot['pending_invites'][number] => !!row);
          pendingInvitesCount = pendingInvites.length;
        } else {
          const countRows = await this.prisma.$queryRaw<Array<{ pending_invites_count: number | string | null }>>`
            select count(*)::integer as pending_invites_count
            from public.org_invites oi
            where oi.org_id = ${membership.orgId}::uuid
              and oi.status = 'pending'::public.org_invite_status
          `;

          pendingInvitesCount = Math.max(
            0,
            this.normalizeInteger(countRows[0]?.pending_invites_count),
          );
        }
      }

      let startupProfile: WorkspaceSettingsSnapshot['startup_profile'] = null;
      let startupPost: WorkspaceSettingsSnapshot['startup_post'] = null;
      let startupReadiness: WorkspaceSettingsSnapshot['startup_readiness'] = null;

      if (membership.orgType === 'startup') {
        if (
          section === 'settings-startup-readiness'
          || section === 'settings-discovery'
          || section === 'settings-data-room'
        ) {
          startupProfile = await this.getStartupProfileForOrg(membership.orgId);
          startupPost = await this.getStartupPostForOrg(membership.orgId);
        }

        startupReadiness =
          bootstrapCached?.membership?.org_id === membership.orgId
            ? (bootstrapCached.startup_readiness ?? null)
            : await this.getStartupReadinessForOrg(membership.orgId);
      }

      const payload: WorkspaceSettingsSnapshot = {
        verification_status: verificationStatus,
        current_plan: currentPlan,
        pending_invites_count: pendingInvitesCount,
        pending_invites: pendingInvites,
        startup_profile: startupProfile,
        startup_post: startupPost,
        startup_readiness: startupReadiness,
      };

      await this.writeWorkspaceCacheValue(
        cacheKey,
        cacheLabel,
        payload,
        this.getWorkspaceSettingsCacheTtlSeconds(),
        metricContext,
      );
      return payload;
    } catch (error) {
      if (this.isMembershipRequiredError(error)) {
        await this.writeWorkspaceCacheEmpty(
          cacheKey,
          cacheLabel,
          'settings-membership-required',
          metricContext,
        );
        return null;
      }

      const message = error instanceof Error ? error.message : 'unknown error';
      this.logCacheDebug(`${cacheLabel} db fetch failed: ${message}`);
      return null;
    }
  }
}
