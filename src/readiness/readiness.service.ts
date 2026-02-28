import { Injectable } from '@nestjs/common';
import { PrismaService, PrismaSqlExecutor } from '../prisma/prisma.service';
import {
  OrganizationReadinessSummaryItem,
  OrganizationReadinessSummaryResult,
  StartupReadinessSectionScore,
  StartupReadinessSnapshot,
} from './readiness.types';

type ReadinessSqlExecutor = PrismaSqlExecutor;

@Injectable()
export class ReadinessService {
  constructor(private readonly prisma: PrismaService) {}

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

  private normalizeOrgType(
    value: string | null | undefined,
  ): OrganizationReadinessSummaryItem['org_type'] | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
    if (normalized === 'startup' || normalized === 'advisor' || normalized === 'investor') {
      return normalized;
    }

    return null;
  }

  private getExecutor(tx?: ReadinessSqlExecutor): ReadinessSqlExecutor {
    return tx ?? this.prisma;
  }

  private normalizeSectionScores(value: unknown): StartupReadinessSectionScore[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item): StartupReadinessSectionScore | null => {
        if (!item || typeof item !== 'object') {
          return null;
        }

        const row = item as Record<string, unknown>;
        const section = this.normalizeOptionalText(
          typeof row.section === 'string' ? row.section : null,
        );
        const weight = this.normalizeInteger(row.weight);
        const completionPercent = this.normalizeInteger(row.completion_percent);
        const scoreContribution = this.normalizeInteger(row.score_contribution);
        if (!section) {
          return null;
        }

        return {
          section,
          weight: Math.max(0, weight),
          completion_percent: Math.max(0, Math.min(100, completionPercent)),
          score_contribution: Math.max(0, Math.min(100, scoreContribution)),
        };
      })
      .filter((item): item is StartupReadinessSectionScore => !!item);
  }

  async getStartupReadinessForOrg(
    orgId: string,
    tx?: ReadinessSqlExecutor,
  ): Promise<StartupReadinessSnapshot | null> {
    const executor = this.getExecutor(tx);

    const rows = await executor.$queryRaw<
      Array<{
        org_id: string;
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
      }>
    >`
      select
        sr.org_id,
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
        coalesce(sr.missing_steps, '{}'::text[]) as missing_steps
        ,
        coalesce(sr.section_scores, '[]'::jsonb) as section_scores
      from public.startup_readiness_v2 sr
      where sr.org_id = ${orgId}::uuid
      limit 1
    `;

    const row = rows[0];
    if (!row?.org_id) {
      return null;
    }

    return {
      startup_org_id: row.org_id,
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
    };
  }

  async listOrganizationReadinessSummary(input?: {
    orgType?: string | null;
    isReady?: boolean | null;
    search?: string | null;
    page?: number | null;
    limit?: number | null;
  }): Promise<OrganizationReadinessSummaryResult> {
    const page = Math.max(1, Math.trunc(input?.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.trunc(input?.limit ?? 20)));
    const offset = (page - 1) * limit;
    const normalizedOrgType = this.normalizeOrgType(input?.orgType ?? null);
    const normalizedSearch = this.normalizeOptionalText(input?.search ?? null);
    const isReadyFilter = typeof input?.isReady === 'boolean' ? input.isReady : null;

    const filterClauses: string[] = [];
    const filterValues: unknown[] = [];

    const addValue = (value: unknown, cast?: string): string => {
      filterValues.push(value);
      const placeholder = `$${filterValues.length}`;
      return cast ? `${placeholder}::${cast}` : placeholder;
    };

    if (normalizedOrgType) {
      filterClauses.push(`ors.org_type = ${addValue(normalizedOrgType, 'public.org_type')}`);
    }

    if (isReadyFilter !== null) {
      filterClauses.push(`ors.is_ready = ${addValue(isReadyFilter, 'boolean')}`);
    }

    if (normalizedSearch) {
      filterClauses.push(`o.name ilike ${addValue(`%${normalizedSearch}%`)}`);
    }

    const whereSql = filterClauses.length > 0 ? `where ${filterClauses.join(' and ')}` : '';
    const baseFromSql = `
      from public.organization_readiness_summary_v1 ors
      join public.organizations o on o.id = ors.org_id
      left join public.org_status os on os.org_id = o.id
      left join public.org_verifications ov on ov.org_id = o.id
    `;

    const countRows = await this.prisma.$queryRaw<
      Array<{
        total: number | string | null;
      }>
    >(
      `
        select count(*)::integer as total
        ${baseFromSql}
        ${whereSql}
      `,
      ...filterValues,
    );

    const pageValues = [...filterValues, limit, offset];
    const limitPlaceholder = `$${filterValues.length + 1}::int`;
    const offsetPlaceholder = `$${filterValues.length + 2}::int`;

    const rows = await this.prisma.$queryRaw<
      Array<{
        org_id: string;
        org_name: string;
        org_type: string | null;
        org_status: string | null;
        verification_status: string | null;
        readiness_score: number | string | null;
        is_ready: boolean;
        missing_steps: string[] | null;
        rules_version: string | null;
        computed_at: string | Date | null;
      }>
    >(
      `
        select
          ors.org_id,
          o.name as org_name,
          ors.org_type::text as org_type,
          coalesce(os.status::text, 'active') as org_status,
          coalesce(ov.status::text, 'unverified') as verification_status,
          coalesce(ors.readiness_score, 0)::integer as readiness_score,
          coalesce(ors.is_ready, false) as is_ready,
          coalesce(ors.missing_steps, '{}'::text[]) as missing_steps,
          coalesce(ors.rules_version, '') as rules_version,
          ors.computed_at
          ${baseFromSql}
          ${whereSql}
        order by ors.readiness_score asc, o.name asc
        limit ${limitPlaceholder}
        offset ${offsetPlaceholder}
      `,
      ...pageValues,
    );

    const items = rows
      .map((row): OrganizationReadinessSummaryItem | null => {
        const orgType = this.normalizeOrgType(row.org_type);
        if (!orgType) {
          return null;
        }

        return {
          org_id: row.org_id,
          org_name: row.org_name,
          org_type: orgType,
          org_status: this.normalizeOptionalText(row.org_status) ?? 'active',
          verification_status: this.normalizeOptionalText(row.verification_status) ?? 'unverified',
          readiness_score: Math.max(0, this.normalizeInteger(row.readiness_score)),
          is_ready: row.is_ready === true,
          missing_steps: Array.isArray(row.missing_steps) ? row.missing_steps : [],
          rules_version: this.normalizeOptionalText(row.rules_version) ?? 'unknown',
          computed_at: this.normalizeTimestamp(row.computed_at),
        };
      })
      .filter((row): row is OrganizationReadinessSummaryItem => !!row);

    return {
      items,
      total: Math.max(0, this.normalizeInteger(countRows[0]?.total)),
      page,
      limit,
    };
  }
}
