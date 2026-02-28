import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReadinessService } from '../readiness/readiness.service';
import { UpstashRedisCacheService } from '../cache/upstash-redis-cache.service';
import {
  StartupPostView,
  StartupProfileView,
  StartupReadinessView,
  UpdateStartupPostInput,
  UpdateStartupProfileInput,
} from './startups.types';

type StartupMembershipContext = {
  orgId: string;
  memberRole: string;
};

@Injectable()
export class StartupsService {
  private readonly logger = new Logger(StartupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
    private readonly cache: UpstashRedisCacheService,
  ) {}

  private normalizeOptionalText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
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

  private normalizeTextArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    );
  }

  private assertStartupEditorRole(memberRole: string, message: string): void {
    if (memberRole !== 'owner' && memberRole !== 'admin') {
      throw new Error(message);
    }
  }

  private async resolveStartupMembershipContext(userId: string): Promise<StartupMembershipContext> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        org_id: string;
        member_role: string;
        org_status: string | null;
      }>
    >`
      select
        om.org_id,
        om.member_role::text as member_role,
        coalesce(s.status::text, 'active') as org_status
      from public.org_members om
      join public.organizations o on o.id = om.org_id
      left join public.org_status s on s.org_id = o.id
      where om.user_id = ${userId}::uuid
        and om.status = 'active'
        and o.type = 'startup'
      order by om.created_at asc
      limit 1
    `;

    const context = rows[0];
    if (!context?.org_id) {
      throw new Error('Startup organization membership is required');
    }

    const orgStatus = this.normalizeOptionalText(context.org_status)?.toLowerCase() ?? 'active';
    if (orgStatus !== 'active') {
      throw new Error('Startup organization is not active');
    }

    const memberRole = this.normalizeOptionalText(context.member_role)?.toLowerCase() ?? '';
    return {
      orgId: context.org_id,
      memberRole,
    };
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

  private async invalidateWorkspaceBootstrapForOrg(orgId: string): Promise<void> {
    const userIds = await this.listActiveOrganizationMemberUserIds(orgId);
    const keys = Array.from(new Set(userIds)).flatMap((userId) => [
      this.cache.workspaceIdentityKey(userId),
      this.cache.workspaceBootstrapKey(userId),
      ...this.cache.workspaceSettingsSnapshotKeysForUser(userId),
    ]);
    if (keys.length < 1) {
      return;
    }

    try {
      await this.cache.deleteMany(keys);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown cache invalidation error';
      this.logger.warn(`Failed to invalidate workspace caches: ${message}`);
    }
  }

  async getStartupReadiness(userId: string): Promise<StartupReadinessView | null> {
    const membership = await this.resolveStartupMembershipContext(userId);
    return this.readiness.getStartupReadinessForOrg(membership.orgId);
  }

  async getStartupProfile(userId: string): Promise<StartupProfileView | null> {
    const membership = await this.resolveStartupMembershipContext(userId);

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
      where o.id = ${membership.orgId}::uuid
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

  async getStartupPost(userId: string): Promise<StartupPostView | null> {
    const membership = await this.resolveStartupMembershipContext(userId);

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
      where sp.startup_org_id = ${membership.orgId}::uuid
      limit 1
    `;

    const row = rows[0];
    if (!row?.id || !row.startup_org_id || !row.title || !row.summary || !row.status || !row.updated_at) {
      return null;
    }

    return {
      id: row.id,
      startup_org_id: row.startup_org_id,
      title: row.title,
      summary: row.summary,
      stage: row.stage,
      location: row.location,
      industry_tags: this.normalizeTextArray(row.industry_tags),
      status: row.status,
      published_at: this.normalizeTimestamp(row.published_at),
      updated_at: this.normalizeTimestamp(row.updated_at) ?? new Date().toISOString(),
    };
  }

  async updateStartupProfile(userId: string, input: UpdateStartupProfileInput): Promise<void> {
    const membership = await this.resolveStartupMembershipContext(userId);
    this.assertStartupEditorRole(
      membership.memberRole,
      'Only startup owner or admin can update startup profile',
    );

    const websiteUrl = this.normalizeOptionalText(input.websiteUrl);
    const pitchDeckUrl = this.normalizeOptionalText(input.pitchDeckUrl);
    const pitchDeckFileName = this.normalizeOptionalText(input.pitchDeckFileName);
    const teamOverview = this.normalizeOptionalText(input.teamOverview);
    const companyStage = this.normalizeOptionalText(input.companyStage);
    const targetMarket = this.normalizeOptionalText(input.targetMarket);
    const businessModel = this.normalizeOptionalText(input.businessModel);
    const tractionSummary = this.normalizeOptionalText(input.tractionSummary);
    const financialSummary = this.normalizeOptionalText(input.financialSummary);
    const legalSummary = this.normalizeOptionalText(input.legalSummary);
    const financialDocUrl = this.normalizeOptionalText(input.financialDocUrl);
    const financialDocFileName = this.normalizeOptionalText(input.financialDocFileName);
    const legalDocUrl = this.normalizeOptionalText(input.legalDocUrl);
    const legalDocFileName = this.normalizeOptionalText(input.legalDocFileName);

    const pitchDeckMediaKindRaw = this.normalizeOptionalText(input.pitchDeckMediaKind)?.toLowerCase();
    let pitchDeckMediaKind: 'document' | 'video' | null = null;
    if (pitchDeckMediaKindRaw) {
      if (pitchDeckMediaKindRaw !== 'document' && pitchDeckMediaKindRaw !== 'video') {
        throw new Error('Pitch deck media kind must be document or video');
      }
      pitchDeckMediaKind = pitchDeckMediaKindRaw;
    }

    const pitchDeckFileSizeBytes =
      typeof input.pitchDeckFileSizeBytes === 'number'
        ? Math.round(input.pitchDeckFileSizeBytes)
        : null;
    if (pitchDeckFileSizeBytes !== null && pitchDeckFileSizeBytes < 0) {
      throw new Error('Pitch deck file size cannot be negative');
    }

    const financialDocFileSizeBytes =
      typeof input.financialDocFileSizeBytes === 'number'
        ? Math.round(input.financialDocFileSizeBytes)
        : null;
    if (financialDocFileSizeBytes !== null && financialDocFileSizeBytes < 0) {
      throw new Error('Financial document file size cannot be negative');
    }

    const legalDocFileSizeBytes =
      typeof input.legalDocFileSizeBytes === 'number'
        ? Math.round(input.legalDocFileSizeBytes)
        : null;
    if (legalDocFileSizeBytes !== null && legalDocFileSizeBytes < 0) {
      throw new Error('Legal document file size cannot be negative');
    }

    const foundingYear =
      typeof input.foundingYear === 'number' ? Math.round(input.foundingYear) : null;
    if (foundingYear !== null && (foundingYear < 1900 || foundingYear > 2100)) {
      throw new Error('Founding year is out of allowed range');
    }

    const teamSize = typeof input.teamSize === 'number' ? Math.round(input.teamSize) : null;
    if (teamSize !== null && teamSize < 1) {
      throw new Error('Team size must be at least 1');
    }

    await this.prisma.$queryRaw`
      insert into public.startup_profiles as sp (
        startup_org_id,
        website_url,
        pitch_deck_url,
        pitch_deck_media_kind,
        pitch_deck_file_name,
        pitch_deck_file_size_bytes,
        team_overview,
        company_stage,
        founding_year,
        team_size,
        target_market,
        business_model,
        traction_summary,
        financial_summary,
        legal_summary,
        financial_doc_url,
        financial_doc_file_name,
        financial_doc_file_size_bytes,
        legal_doc_url,
        legal_doc_file_name,
        legal_doc_file_size_bytes,
        updated_by,
        updated_at
      )
      values (
        ${membership.orgId}::uuid,
        ${websiteUrl},
        ${pitchDeckUrl},
        ${pitchDeckMediaKind},
        ${pitchDeckFileName},
        ${pitchDeckFileSizeBytes},
        ${teamOverview},
        ${companyStage},
        ${foundingYear},
        ${teamSize},
        ${targetMarket},
        ${businessModel},
        ${tractionSummary},
        ${financialSummary},
        ${legalSummary},
        ${financialDocUrl},
        ${financialDocFileName},
        ${financialDocFileSizeBytes},
        ${legalDocUrl},
        ${legalDocFileName},
        ${legalDocFileSizeBytes},
        ${userId}::uuid,
        timezone('utc', now())
      )
      on conflict (startup_org_id) do update
      set
        website_url = excluded.website_url,
        pitch_deck_url = excluded.pitch_deck_url,
        pitch_deck_media_kind = excluded.pitch_deck_media_kind,
        pitch_deck_file_name = excluded.pitch_deck_file_name,
        pitch_deck_file_size_bytes = excluded.pitch_deck_file_size_bytes,
        team_overview = excluded.team_overview,
        company_stage = excluded.company_stage,
        founding_year = excluded.founding_year,
        team_size = excluded.team_size,
        target_market = excluded.target_market,
        business_model = excluded.business_model,
        traction_summary = excluded.traction_summary,
        financial_summary = excluded.financial_summary,
        legal_summary = excluded.legal_summary,
        financial_doc_url = excluded.financial_doc_url,
        financial_doc_file_name = excluded.financial_doc_file_name,
        financial_doc_file_size_bytes = excluded.financial_doc_file_size_bytes,
        legal_doc_url = excluded.legal_doc_url,
        legal_doc_file_name = excluded.legal_doc_file_name,
        legal_doc_file_size_bytes = excluded.legal_doc_file_size_bytes,
        updated_by = ${userId}::uuid,
        updated_at = timezone('utc', now())
    `;

    await this.invalidateWorkspaceBootstrapForOrg(membership.orgId);
  }

  async updateStartupPost(userId: string, input: UpdateStartupPostInput): Promise<string> {
    const membership = await this.resolveStartupMembershipContext(userId);
    this.assertStartupEditorRole(
      membership.memberRole,
      'Only startup owner or admin can update startup post',
    );

    const title = this.normalizeOptionalText(input.title);
    if (!title || title.length < 3) {
      throw new Error('Startup post title must be at least 3 characters');
    }

    const summary = this.normalizeOptionalText(input.summary);
    if (!summary || summary.length < 20) {
      throw new Error('Startup post summary must be at least 20 characters');
    }

    const stage = this.normalizeOptionalText(input.stage);
    const location = this.normalizeOptionalText(input.location);
    const industryTags = this.normalizeTextArray(input.industryTags).slice(0, 20);
    const status = this.normalizeOptionalText(input.status)?.toLowerCase();
    if (status !== 'draft' && status !== 'published') {
      throw new Error('Startup post status must be draft or published');
    }

    if (status === 'published') {
      const readiness = await this.readiness.getStartupReadinessForOrg(membership.orgId);
      if (!readiness || !readiness.eligible_for_discovery_post) {
        const missing = readiness?.missing_steps?.length
          ? ` Missing: ${readiness.missing_steps.join(', ')}.`
          : '';
        throw new Error(
          `Startup discovery post cannot be published until readiness requirements are met.${missing}`,
        );
      }
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      insert into public.startup_posts as sp (
        startup_org_id,
        title,
        summary,
        stage,
        location,
        industry_tags,
        status,
        published_at,
        created_by,
        updated_by,
        updated_at
      )
      values (
        ${membership.orgId}::uuid,
        ${title},
        ${summary},
        ${stage},
        ${location},
        ${industryTags}::text[],
        ${status}::public.startup_post_status,
        case
          when ${status}::public.startup_post_status = 'published'::public.startup_post_status
            then timezone('utc', now())
          else null
        end,
        ${userId}::uuid,
        ${userId}::uuid,
        timezone('utc', now())
      )
      on conflict (startup_org_id) do update
      set
        title = excluded.title,
        summary = excluded.summary,
        stage = excluded.stage,
        location = excluded.location,
        industry_tags = excluded.industry_tags,
        status = excluded.status,
        published_at = case
          when excluded.status = 'published'::public.startup_post_status
            then coalesce(sp.published_at, timezone('utc', now()))
          else null
        end,
        updated_by = ${userId}::uuid,
        updated_at = timezone('utc', now())
      returning id
    `;

    const postId = rows[0]?.id;
    if (!postId) {
      throw new Error('Unable to update startup post right now.');
    }

    await this.invalidateWorkspaceBootstrapForOrg(membership.orgId);
    return postId;
  }
}
