import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ReadinessService } from '../readiness/readiness.service';
import { UpstashRedisCacheService } from '../cache/upstash-redis-cache.service';
import {
  STARTUP_DATA_ROOM_DOCUMENT_TYPES,
  StartupDataRoomDocumentType,
  StartupDataRoomDocumentView,
  StartupPostView,
  StartupProfileView,
  StartupReadinessView,
  UpsertStartupDataRoomDocumentInput,
  UpdateStartupPostInput,
  UpdateStartupProfileInput,
} from './startups.types';

type StartupMembershipContext = {
  orgId: string;
  memberRole: string;
};

const STARTUP_DATA_ROOM_DOCUMENT_TYPE_SET = new Set<StartupDataRoomDocumentType>(
  STARTUP_DATA_ROOM_DOCUMENT_TYPES,
);
const STARTUP_DATA_ROOM_ASSET_BUCKET = 'startup-data-room-assets';
const SUPABASE_PUBLIC_STORAGE_OBJECT_BASE_PATH = '/storage/v1/object/public';
const SUPABASE_PUBLIC_STORAGE_OBJECT_PREFIX = `${SUPABASE_PUBLIC_STORAGE_OBJECT_BASE_PATH}/`;

@Injectable()
export class StartupsService {
  private readonly logger = new Logger(StartupsService.name);
  private readonly supabaseStoragePublicBaseUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
    private readonly cache: UpstashRedisCacheService,
    private readonly config: ConfigService,
  ) {
    const supabaseUrlRaw = this.normalizeOptionalText(this.config.get<string>('supabaseUrl'));
    this.supabaseStoragePublicBaseUrl = supabaseUrlRaw
      ? `${supabaseUrlRaw.replace(/\/+$/, '')}${SUPABASE_PUBLIC_STORAGE_OBJECT_BASE_PATH}`
      : null;
  }

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

  private buildSupabasePublicStorageUrl(bucketId: string, objectPath: string): string | null {
    if (!this.supabaseStoragePublicBaseUrl) {
      return null;
    }

    return `${this.supabaseStoragePublicBaseUrl}/${bucketId}/${objectPath}`;
  }

  private resolveDocumentPublicUrl(
    fileUrl: string | null | undefined,
    storageBucket: string | null | undefined,
    storageObjectPath: string | null | undefined,
  ): string | null {
    const normalizedFileUrl = this.normalizeOptionalText(fileUrl);
    if (normalizedFileUrl) {
      return normalizedFileUrl;
    }

    const bucketId = this.normalizeOptionalText(storageBucket);
    const objectPath = this.normalizeOptionalText(storageObjectPath);
    if (!bucketId || !objectPath) {
      return null;
    }

    return this.buildSupabasePublicStorageUrl(bucketId, objectPath);
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

  private normalizeUuid(value: string | null | undefined): string | null {
    const normalized = this.normalizeOptionalText(value);
    if (!normalized) {
      return null;
    }

    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized,
    )
      ? normalized
      : null;
  }

  private normalizeStartupDataRoomDocumentType(
    value: string | null | undefined,
  ): StartupDataRoomDocumentType | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
    if (
      normalized
      && STARTUP_DATA_ROOM_DOCUMENT_TYPE_SET.has(normalized as StartupDataRoomDocumentType)
    ) {
      return normalized as StartupDataRoomDocumentType;
    }

    return null;
  }

  private resolveDefaultDocumentTitle(documentType: StartupDataRoomDocumentType): string {
    if (documentType === 'pitch_deck') {
      return 'Pitch Deck';
    }

    if (documentType === 'financial_doc') {
      return 'Financial Readiness Document';
    }

    if (documentType === 'legal_doc') {
      return 'Legal Readiness Document';
    }

    return 'Data Room Document';
  }

  private async syncProfileDocument(input: {
    orgId: string;
    userId: string;
    documentType: StartupDataRoomDocumentType;
    shouldMutate: boolean;
    fileUrl: string | null;
    fileName?: string | null;
    fileSizeBytes?: number | null;
    contentType?: string | null;
    title?: string | null;
  }): Promise<void> {
    if (!input.shouldMutate) {
      return;
    }

    if (!input.fileUrl) {
      await this.prisma.$queryRaw`
        delete from public.startup_data_room_documents d
        where d.startup_org_id = ${input.orgId}::uuid
          and d.document_type = ${input.documentType}::public.startup_data_room_document_type
      `;
      return;
    }

    const storageTarget = this.resolveStorageTargetFromInput({
      fileUrl: input.fileUrl,
      storageBucket: null,
      storageObjectPath: null,
    });
    this.assertStorageTargetForStartupDocument({
      target: storageTarget,
      expectedBucket: STARTUP_DATA_ROOM_ASSET_BUCKET,
      orgId: input.orgId,
      contextLabel: 'Readiness document URL',
    });

    const resolvedTitle =
      this.normalizeOptionalText(input.title) ?? this.resolveDefaultDocumentTitle(input.documentType);

    await this.prisma.$queryRaw`
      insert into public.startup_data_room_documents as d (
        startup_org_id,
        document_type,
        title,
        file_url,
        storage_bucket,
        storage_object_path,
        file_name,
        file_size_bytes,
        content_type,
        uploaded_by,
        updated_at
      )
      values (
        ${input.orgId}::uuid,
        ${input.documentType}::public.startup_data_room_document_type,
        ${resolvedTitle},
        ${input.fileUrl},
        ${storageTarget?.bucketId ?? null},
        ${storageTarget?.objectPath ?? null},
        ${input.fileName ?? null},
        ${input.fileSizeBytes ?? null},
        ${input.contentType ?? null},
        ${input.userId}::uuid,
        timezone('utc', now())
      )
      on conflict (startup_org_id, document_type) do update
      set
        title = excluded.title,
        file_url = excluded.file_url,
        storage_bucket = excluded.storage_bucket,
        storage_object_path = excluded.storage_object_path,
        file_name = excluded.file_name,
        file_size_bytes = excluded.file_size_bytes,
        content_type = excluded.content_type,
        uploaded_by = ${input.userId}::uuid,
        updated_at = timezone('utc', now())
    `;
  }

  private isValidHttpUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private resolveSupabasePublicStorageTarget(
    fileUrl: string,
  ): { bucketId: string; objectPath: string } | null {
    try {
      const parsed = new URL(fileUrl);
      const pathname = parsed.pathname ?? '';
      if (!pathname.startsWith(SUPABASE_PUBLIC_STORAGE_OBJECT_PREFIX)) {
        return null;
      }

      const remainder = decodeURIComponent(
        pathname.slice(SUPABASE_PUBLIC_STORAGE_OBJECT_PREFIX.length),
      ).trim();
      if (!remainder) {
        return null;
      }

      const [bucketIdRaw, ...pathParts] = remainder.split('/');
      const bucketId = this.normalizeOptionalText(bucketIdRaw);
      const objectPath = this.normalizeOptionalText(pathParts.join('/'));
      if (!bucketId || !objectPath) {
        return null;
      }

      return { bucketId, objectPath };
    } catch {
      return null;
    }
  }

  private resolveStorageTargetFromInput(input: {
    fileUrl: string | null;
    storageBucket?: string | null;
    storageObjectPath?: string | null;
  }): { bucketId: string; objectPath: string } | null {
    const fileUrl = this.normalizeOptionalText(input.fileUrl);
    const storageBucket = this.normalizeOptionalText(input.storageBucket);
    const storageObjectPath = this.normalizeOptionalText(input.storageObjectPath);

    if ((storageBucket && !storageObjectPath) || (!storageBucket && storageObjectPath)) {
      throw new Error('Storage bucket and object path must be provided together.');
    }

    if (storageBucket && storageObjectPath) {
      return {
        bucketId: storageBucket,
        objectPath: storageObjectPath,
      };
    }

    if (fileUrl) {
      return this.resolveSupabasePublicStorageTarget(fileUrl);
    }

    return null;
  }

  private assertStorageTargetForStartupDocument(input: {
    target: { bucketId: string; objectPath: string } | null;
    expectedBucket: string;
    orgId: string;
    contextLabel: string;
  }): void {
    const target = input.target;
    if (!target) {
      return;
    }

    if (target.bucketId !== input.expectedBucket) {
      throw new Error(`${input.contextLabel} must be uploaded to ${input.expectedBucket}.`);
    }

    const orgPrefix = `${input.orgId}/`;
    if (!target.objectPath.startsWith(orgPrefix)) {
      throw new Error(`${input.contextLabel} must belong to your startup organization folder.`);
    }
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

  private async assertDataRoomDocumentsAvailableForPlan(
    orgId: string,
    documentType: StartupDataRoomDocumentType,
  ): Promise<void> {
    const featureRows = await this.prisma.$queryRaw<
      Array<{
        limit_value: number | string | null;
        is_unlimited: boolean;
      }>
    >`
      select
        pf.limit_value,
        pf.is_unlimited
      from public.org_current_subscription_plan_v1 cp
      join public.billing_plan_features pf on pf.plan_id = cp.plan_id
      where cp.org_id = ${orgId}::uuid
        and pf.feature_key = 'data_room_documents_limit'
      limit 1
    `;

    const feature = featureRows[0];
    if (!feature) {
      throw new Error('Data room documents are not included in your current plan.');
    }

    if (feature.is_unlimited === true) {
      return;
    }

    const limit = Math.max(0, this.normalizeNullableInteger(feature.limit_value) ?? 0);
    if (limit < 1) {
      throw new Error('Data room documents are not enabled for your current plan.');
    }

    const existingRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      select d.id
      from public.startup_data_room_documents d
      where d.startup_org_id = ${orgId}::uuid
        and d.document_type = ${documentType}::public.startup_data_room_document_type
      limit 1
    `;
    if (existingRows[0]?.id) {
      return;
    }

    const countRows = await this.prisma.$queryRaw<Array<{ document_count: number | string | null }>>`
      select count(*)::integer as document_count
      from public.startup_data_room_documents d
      where d.startup_org_id = ${orgId}::uuid
    `;
    const documentCount = Math.max(0, this.normalizeNullableInteger(countRows[0]?.document_count) ?? 0);
    if (documentCount >= limit) {
      throw new Error('You have reached your plan limit for data room documents. Upgrade to add more.');
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
        pitch_deck_storage_bucket: string | null;
        pitch_deck_storage_object_path: string | null;
        pitch_deck_media_kind: string | null;
        pitch_deck_file_name: string | null;
        pitch_deck_file_size_bytes: number | string | null;
        pitch_deck_content_type: string | null;
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
        financial_doc_storage_bucket: string | null;
        financial_doc_storage_object_path: string | null;
        financial_doc_file_name: string | null;
        financial_doc_file_size_bytes: number | string | null;
        financial_doc_content_type: string | null;
        legal_doc_url: string | null;
        legal_doc_storage_bucket: string | null;
        legal_doc_storage_object_path: string | null;
        legal_doc_file_name: string | null;
        legal_doc_file_size_bytes: number | string | null;
        legal_doc_content_type: string | null;
        updated_at: string | Date | null;
      }>
    >`
      select
        o.id as startup_org_id,
        nullif(trim(coalesce(sp.website_url, '')), '') as website_url,
        nullif(trim(coalesce(pitch_doc.file_url, '')), '') as pitch_deck_url,
        nullif(trim(coalesce(pitch_doc.storage_bucket, '')), '') as pitch_deck_storage_bucket,
        nullif(trim(coalesce(pitch_doc.storage_object_path, '')), '') as pitch_deck_storage_object_path,
        case
          when coalesce(pitch_doc.content_type, '') ilike 'video/%'
            then 'video'
          when coalesce(pitch_doc.file_name, '') ~* '\\.(mp4|webm|mov)$'
            then 'video'
          when coalesce(pitch_doc.file_url, '') ~* '\\.(mp4|webm|mov)(\\?|$)'
            then 'video'
          when pitch_doc.file_url is not null
            then 'document'
          else null
        end as pitch_deck_media_kind,
        nullif(trim(coalesce(pitch_doc.file_name, '')), '') as pitch_deck_file_name,
        pitch_doc.file_size_bytes as pitch_deck_file_size_bytes,
        nullif(trim(coalesce(pitch_doc.content_type, '')), '') as pitch_deck_content_type,
        nullif(trim(coalesce(sp.team_overview, '')), '') as team_overview,
        nullif(trim(coalesce(sp.company_stage, '')), '') as company_stage,
        sp.founding_year,
        sp.team_size,
        nullif(trim(coalesce(sp.target_market, '')), '') as target_market,
        nullif(trim(coalesce(sp.business_model, '')), '') as business_model,
        nullif(trim(coalesce(sp.traction_summary, '')), '') as traction_summary,
        nullif(trim(coalesce(sp.financial_summary, '')), '') as financial_summary,
        nullif(trim(coalesce(sp.legal_summary, '')), '') as legal_summary,
        nullif(trim(coalesce(fin_doc.file_url, '')), '') as financial_doc_url,
        nullif(trim(coalesce(fin_doc.storage_bucket, '')), '') as financial_doc_storage_bucket,
        nullif(trim(coalesce(fin_doc.storage_object_path, '')), '') as financial_doc_storage_object_path,
        nullif(trim(coalesce(fin_doc.file_name, '')), '') as financial_doc_file_name,
        fin_doc.file_size_bytes as financial_doc_file_size_bytes,
        nullif(trim(coalesce(fin_doc.content_type, '')), '') as financial_doc_content_type,
        nullif(trim(coalesce(legal_doc.file_url, '')), '') as legal_doc_url,
        nullif(trim(coalesce(legal_doc.storage_bucket, '')), '') as legal_doc_storage_bucket,
        nullif(trim(coalesce(legal_doc.storage_object_path, '')), '') as legal_doc_storage_object_path,
        nullif(trim(coalesce(legal_doc.file_name, '')), '') as legal_doc_file_name,
        legal_doc.file_size_bytes as legal_doc_file_size_bytes,
        nullif(trim(coalesce(legal_doc.content_type, '')), '') as legal_doc_content_type,
        sp.updated_at
      from public.organizations o
      left join public.startup_profiles sp on sp.startup_org_id = o.id
      left join lateral (
        select
          d.file_url,
          d.storage_bucket,
          d.storage_object_path,
          d.file_name,
          d.file_size_bytes,
          d.content_type
        from public.startup_data_room_documents d
        where d.startup_org_id = o.id
          and d.document_type = 'pitch_deck'::public.startup_data_room_document_type
        order by d.updated_at desc
        limit 1
      ) pitch_doc on true
      left join lateral (
        select
          d.file_url,
          d.storage_bucket,
          d.storage_object_path,
          d.file_name,
          d.file_size_bytes,
          d.content_type
        from public.startup_data_room_documents d
        where d.startup_org_id = o.id
          and d.document_type::text = any (
            array[
              'financial_doc',
              'financial_model'
            ]
          )
        order by
          case d.document_type::text
            when 'financial_doc' then 1
            else 2
          end asc,
          d.updated_at desc
        limit 1
      ) fin_doc on true
      left join lateral (
        select
          d.file_url,
          d.storage_bucket,
          d.storage_object_path,
          d.file_name,
          d.file_size_bytes,
          d.content_type
        from public.startup_data_room_documents d
        where d.startup_org_id = o.id
          and d.document_type::text = any (
            array[
              'legal_doc',
              'legal_company_docs',
              'incorporation_docs',
              'customer_contracts_summaries',
              'term_sheet_drafts'
            ]
          )
        order by
          case d.document_type::text
            when 'legal_doc' then 1
            when 'legal_company_docs' then 2
            when 'incorporation_docs' then 3
            when 'customer_contracts_summaries' then 4
            when 'term_sheet_drafts' then 5
            else 999
          end asc,
          d.updated_at desc
        limit 1
      ) legal_doc on true
      where o.id = ${membership.orgId}::uuid
        and o.type = 'startup'::public.org_type
      limit 1
    `;

    const row = rows[0];
    if (!row?.startup_org_id) {
      return null;
    }

    const pitchDeckUrl = this.resolveDocumentPublicUrl(
      row.pitch_deck_url,
      row.pitch_deck_storage_bucket,
      row.pitch_deck_storage_object_path,
    );
    const financialDocUrl = this.resolveDocumentPublicUrl(
      row.financial_doc_url,
      row.financial_doc_storage_bucket,
      row.financial_doc_storage_object_path,
    );
    const legalDocUrl = this.resolveDocumentPublicUrl(
      row.legal_doc_url,
      row.legal_doc_storage_bucket,
      row.legal_doc_storage_object_path,
    );

    return {
      startup_org_id: row.startup_org_id,
      website_url: row.website_url,
      pitch_deck_url: pitchDeckUrl,
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
      financial_doc_url: financialDocUrl,
      financial_doc_file_name: row.financial_doc_file_name,
      financial_doc_file_size_bytes: this.normalizeNullableInteger(row.financial_doc_file_size_bytes),
      legal_doc_url: legalDocUrl,
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

  async listStartupDataRoomDocuments(userId: string): Promise<StartupDataRoomDocumentView[]> {
    const membership = await this.resolveStartupMembershipContext(userId);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        startup_org_id: string;
        document_type: string | null;
        title: string | null;
        file_url: string | null;
        storage_bucket: string | null;
        storage_object_path: string | null;
        file_name: string | null;
        file_size_bytes: number | string | null;
        content_type: string | null;
        summary: string | null;
        created_at: string | Date | null;
        updated_at: string | Date | null;
      }>
    >`
      select
        d.id,
        d.startup_org_id,
        d.document_type::text as document_type,
        d.title,
        d.file_url,
        d.storage_bucket,
        d.storage_object_path,
        d.file_name,
        d.file_size_bytes,
        d.content_type,
        d.summary,
        d.created_at,
        d.updated_at
      from public.startup_data_room_documents d
      where d.startup_org_id = ${membership.orgId}::uuid
      order by
        case d.document_type::text
          when 'pitch_deck' then 1
          when 'financial_doc' then 2
          when 'legal_doc' then 3
          when 'financial_model' then 4
          when 'cap_table' then 5
          when 'traction_metrics' then 6
          when 'legal_company_docs' then 7
          when 'incorporation_docs' then 8
          when 'customer_contracts_summaries' then 9
          when 'term_sheet_drafts' then 10
          else 999
        end asc,
        d.updated_at desc
    `;

    return rows
      .map((row): StartupDataRoomDocumentView | null => {
        const id = this.normalizeUuid(row.id);
        const startupOrgId = this.normalizeUuid(row.startup_org_id);
        const documentType = this.normalizeStartupDataRoomDocumentType(row.document_type);
        const title = this.normalizeOptionalText(row.title);
        const storageBucket = this.normalizeOptionalText(row.storage_bucket);
        const storageObjectPath = this.normalizeOptionalText(row.storage_object_path);
        const fileUrl = this.resolveDocumentPublicUrl(
          row.file_url,
          storageBucket,
          storageObjectPath,
        );
        const createdAt = this.normalizeTimestamp(row.created_at);
        const updatedAt = this.normalizeTimestamp(row.updated_at);
        if (
          !id
          || !startupOrgId
          || !documentType
          || !title
          || !fileUrl
          || !createdAt
          || !updatedAt
        ) {
          return null;
        }

        return {
          id,
          startup_org_id: startupOrgId,
          document_type: documentType,
          title,
          file_url: fileUrl,
          storage_bucket: storageBucket,
          storage_object_path: storageObjectPath,
          file_name: this.normalizeOptionalText(row.file_name),
          file_size_bytes: this.normalizeNullableInteger(row.file_size_bytes),
          content_type: this.normalizeOptionalText(row.content_type),
          summary: this.normalizeOptionalText(row.summary),
          created_at: createdAt,
          updated_at: updatedAt,
        };
      })
      .filter((row): row is StartupDataRoomDocumentView => !!row);
  }

  async upsertStartupDataRoomDocument(
    userId: string,
    input: UpsertStartupDataRoomDocumentInput,
  ): Promise<void> {
    const membership = await this.resolveStartupMembershipContext(userId);
    this.assertStartupEditorRole(
      membership.memberRole,
      'Only startup owner or admin can manage data room documents',
    );

    const documentType = this.normalizeStartupDataRoomDocumentType(input.documentType);
    if (!documentType) {
      throw new Error('Data room document type is invalid.');
    }

    const title = this.normalizeOptionalText(input.title);
    if (!title || title.length < 2) {
      throw new Error('Data room document title must be at least 2 characters.');
    }

    const inputFileUrl = this.normalizeOptionalText(input.fileUrl);
    if (inputFileUrl && !this.isValidHttpUrl(inputFileUrl)) {
      throw new Error('Data room document URL must be a valid http/https link.');
    }

    const storageTarget = this.resolveStorageTargetFromInput({
      fileUrl: inputFileUrl,
      storageBucket: input.storageBucket,
      storageObjectPath: input.storageObjectPath,
    });
    this.assertStorageTargetForStartupDocument({
      target: storageTarget,
      expectedBucket: STARTUP_DATA_ROOM_ASSET_BUCKET,
      orgId: membership.orgId,
      contextLabel: 'Data room document URL',
    });
    const fileUrl = (
      inputFileUrl
      ?? (
        storageTarget
          ? this.buildSupabasePublicStorageUrl(storageTarget.bucketId, storageTarget.objectPath)
          : null
      )
    );
    if (!fileUrl) {
      throw new Error('Data room document URL or storage reference is required.');
    }

    const fileName = this.normalizeOptionalText(input.fileName);
    const contentType = this.normalizeOptionalText(input.contentType);
    const summary = this.normalizeOptionalText(input.summary);
    const fileSizeBytes =
      typeof input.fileSizeBytes === 'number'
        ? Math.round(input.fileSizeBytes)
        : null;
    if (fileSizeBytes !== null && fileSizeBytes < 1) {
      throw new Error('Data room document file size must be positive.');
    }

    await this.assertDataRoomDocumentsAvailableForPlan(membership.orgId, documentType);

    await this.prisma.$queryRaw`
      insert into public.startup_data_room_documents as d (
        startup_org_id,
        document_type,
        title,
        file_url,
        storage_bucket,
        storage_object_path,
        file_name,
        file_size_bytes,
        content_type,
        summary,
        uploaded_by,
        updated_at
      )
      values (
        ${membership.orgId}::uuid,
        ${documentType}::public.startup_data_room_document_type,
        ${title},
        ${fileUrl},
        ${storageTarget?.bucketId ?? null},
        ${storageTarget?.objectPath ?? null},
        ${fileName},
        ${fileSizeBytes},
        ${contentType},
        ${summary},
        ${userId}::uuid,
        timezone('utc', now())
      )
      on conflict (startup_org_id, document_type) do update
      set
        title = excluded.title,
        file_url = excluded.file_url,
        storage_bucket = excluded.storage_bucket,
        storage_object_path = excluded.storage_object_path,
        file_name = excluded.file_name,
        file_size_bytes = excluded.file_size_bytes,
        content_type = excluded.content_type,
        summary = excluded.summary,
        uploaded_by = ${userId}::uuid,
        updated_at = timezone('utc', now())
    `;

    await this.invalidateWorkspaceBootstrapForOrg(membership.orgId);
  }

  async deleteStartupDataRoomDocument(userId: string, documentId: string): Promise<void> {
    const membership = await this.resolveStartupMembershipContext(userId);
    this.assertStartupEditorRole(
      membership.memberRole,
      'Only startup owner or admin can manage data room documents',
    );

    const normalizedDocumentId = this.normalizeUuid(documentId);
    if (!normalizedDocumentId) {
      throw new Error('Data room document id is invalid.');
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      delete from public.startup_data_room_documents d
      where d.id = ${normalizedDocumentId}::uuid
        and d.startup_org_id = ${membership.orgId}::uuid
      returning d.id
    `;

    if (!rows[0]?.id) {
      throw new Error('Data room document was not found.');
    }

    await this.invalidateWorkspaceBootstrapForOrg(membership.orgId);
  }

  async updateStartupProfile(userId: string, input: UpdateStartupProfileInput): Promise<void> {
    const membership = await this.resolveStartupMembershipContext(userId);
    this.assertStartupEditorRole(
      membership.memberRole,
      'Only startup owner or admin can update startup profile',
    );

    const websiteUrl = this.normalizeOptionalText(input.websiteUrl);
    const teamOverview = this.normalizeOptionalText(input.teamOverview);
    const companyStage = this.normalizeOptionalText(input.companyStage);
    const targetMarket = this.normalizeOptionalText(input.targetMarket);
    const businessModel = this.normalizeOptionalText(input.businessModel);
    const tractionSummary = this.normalizeOptionalText(input.tractionSummary);
    const financialSummary = this.normalizeOptionalText(input.financialSummary);
    const legalSummary = this.normalizeOptionalText(input.legalSummary);

    const pitchDeckUrl = this.normalizeOptionalText(input.pitchDeckUrl);
    const pitchDeckFileName = this.normalizeOptionalText(input.pitchDeckFileName);
    const financialDocUrl = this.normalizeOptionalText(input.financialDocUrl);
    const financialDocFileName = this.normalizeOptionalText(input.financialDocFileName);
    const legalDocUrl = this.normalizeOptionalText(input.legalDocUrl);
    const legalDocFileName = this.normalizeOptionalText(input.legalDocFileName);

    const shouldMutatePitchDeckDoc = (
      input.pitchDeckUrl !== undefined
      || input.pitchDeckFileName !== undefined
      || input.pitchDeckFileSizeBytes !== undefined
      || input.pitchDeckMediaKind !== undefined
    );
    const shouldMutateFinancialDoc = (
      input.financialDocUrl !== undefined
      || input.financialDocFileName !== undefined
      || input.financialDocFileSizeBytes !== undefined
    );
    const shouldMutateLegalDoc = (
      input.legalDocUrl !== undefined
      || input.legalDocFileName !== undefined
      || input.legalDocFileSizeBytes !== undefined
    );

    if (websiteUrl && !this.isValidHttpUrl(websiteUrl)) {
      throw new Error('Website URL must be a valid http/https link');
    }

    if (shouldMutatePitchDeckDoc && pitchDeckUrl && !this.isValidHttpUrl(pitchDeckUrl)) {
      throw new Error('Pitch deck URL must be a valid http/https link');
    }

    if (shouldMutateFinancialDoc && financialDocUrl && !this.isValidHttpUrl(financialDocUrl)) {
      throw new Error('Financial document URL must be a valid http/https link');
    }

    if (shouldMutateLegalDoc && legalDocUrl && !this.isValidHttpUrl(legalDocUrl)) {
      throw new Error('Legal document URL must be a valid http/https link');
    }

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
        team_overview,
        company_stage,
        founding_year,
        team_size,
        target_market,
        business_model,
        traction_summary,
        financial_summary,
        legal_summary,
        updated_by,
        updated_at
      )
      values (
        ${membership.orgId}::uuid,
        ${websiteUrl},
        ${teamOverview},
        ${companyStage},
        ${foundingYear},
        ${teamSize},
        ${targetMarket},
        ${businessModel},
        ${tractionSummary},
        ${financialSummary},
        ${legalSummary},
        ${userId}::uuid,
        timezone('utc', now())
      )
      on conflict (startup_org_id) do update
      set
        website_url = excluded.website_url,
        team_overview = excluded.team_overview,
        company_stage = excluded.company_stage,
        founding_year = excluded.founding_year,
        team_size = excluded.team_size,
        target_market = excluded.target_market,
        business_model = excluded.business_model,
        traction_summary = excluded.traction_summary,
        financial_summary = excluded.financial_summary,
        legal_summary = excluded.legal_summary,
        updated_by = ${userId}::uuid,
        updated_at = timezone('utc', now())
    `;

    await this.syncProfileDocument({
      orgId: membership.orgId,
      userId,
      documentType: 'pitch_deck',
      shouldMutate: shouldMutatePitchDeckDoc,
      fileUrl: pitchDeckUrl,
      fileName: pitchDeckFileName,
      fileSizeBytes: pitchDeckFileSizeBytes,
      contentType: (
        pitchDeckMediaKind === 'video'
          ? 'video/mp4'
          : pitchDeckMediaKind === 'document'
            ? 'application/pdf'
            : null
      ),
    });

    await this.syncProfileDocument({
      orgId: membership.orgId,
      userId,
      documentType: 'financial_doc',
      shouldMutate: shouldMutateFinancialDoc,
      fileUrl: financialDocUrl,
      fileName: financialDocFileName,
      fileSizeBytes: financialDocFileSizeBytes,
      contentType: null,
    });

    await this.syncProfileDocument({
      orgId: membership.orgId,
      userId,
      documentType: 'legal_doc',
      shouldMutate: shouldMutateLegalDoc,
      fileUrl: legalDocUrl,
      fileName: legalDocFileName,
      fileSizeBytes: legalDocFileSizeBytes,
      contentType: null,
    });

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
