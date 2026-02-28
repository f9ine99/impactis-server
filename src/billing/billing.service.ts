import { Injectable, Logger } from '@nestjs/common';
import { UpstashRedisCacheService } from '../cache/upstash-redis-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BillingFeatureUsageSnapshot,
  BillingInterval,
  BillingMeView,
  BillingPlansView,
  BillingPlanView,
  BillingSegment,
  BillingSubscriptionStatus,
  OrganizationCurrentPlanSnapshot,
  UpdateBillingSubscriptionInput,
} from './billing.types';

type BillingMembershipContext = {
  orgId: string;
  orgType: BillingSegment;
  memberRole: 'owner' | 'admin' | 'member';
};

type BillingPlanRow = {
  plan_id: string;
  segment: string | null;
  plan_code: string;
  display_name: string;
  plan_tier: number | string | null;
  is_default: boolean;
  monthly_price_cents: number | string | null;
  annual_price_cents: number | string | null;
  currency: string | null;
};

type BillingPlanFeatureRow = {
  plan_id: string;
  feature_key: string;
  feature_label: string;
  feature_value_text: string | null;
  limit_value: number | string | null;
  is_unlimited: boolean;
};

type CurrentPlanRow = {
  org_id: string;
  org_type: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
  billing_interval: string | null;
  started_at: string | Date | null;
  current_period_start: string | Date | null;
  current_period_end: string | Date | null;
  cancel_at_period_end: boolean;
  canceled_at: string | Date | null;
  plan_id: string | null;
  plan_code: string | null;
  plan_name: string | null;
  plan_tier: number | string | null;
  monthly_price_cents: number | string | null;
  annual_price_cents: number | string | null;
  currency: string | null;
  is_fallback_free: boolean;
};

type FeatureUsageRow = {
  feature_key: string;
  usage_count: number | string | null;
  period_start: string | Date | null;
  period_end: string | Date | null;
};

type BillingPlanCatalogLookupRow = {
  id: string;
  segment: string | null;
  plan_code: string;
};

type BillingPlanPriceIntervalRow = {
  billing_interval: string | null;
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

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
      return Math.trunc(value);
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

  private normalizeDate(value: string | Date | null | undefined): string | null {
    const normalized = this.normalizeTimestamp(value);
    if (!normalized) {
      return null;
    }

    return normalized.slice(0, 10);
  }

  private normalizeSegment(value: string | null | undefined): BillingSegment | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
    if (normalized === 'startup' || normalized === 'investor' || normalized === 'advisor') {
      return normalized;
    }

    if (normalized === 'consultant') {
      return 'advisor';
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

  private normalizeBillingInterval(value: string | null | undefined): BillingInterval | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
    if (normalized === 'monthly' || normalized === 'annual') {
      return normalized;
    }

    return null;
  }

  private normalizeSubscriptionStatus(
    value: string | null | undefined,
  ): BillingSubscriptionStatus | null {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
    if (
      normalized === 'trialing'
      || normalized === 'active'
      || normalized === 'past_due'
      || normalized === 'paused'
      || normalized === 'canceled'
      || normalized === 'incomplete'
    ) {
      return normalized;
    }

    return null;
  }

  private async resolveMembershipContext(userId: string): Promise<BillingMembershipContext> {
    const rows = await this.prisma.$queryRaw<
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
      left join public.org_status os on os.org_id = o.id
      where om.user_id = ${userId}::uuid
        and om.status = 'active'
        and coalesce(os.status::text, 'active') = 'active'
      order by om.created_at asc
      limit 1
    `;

    const membership = rows[0];
    const orgType = this.normalizeSegment(membership?.org_type ?? null);
    const memberRole = this.normalizeMemberRole(membership?.member_role ?? null);
    if (!membership?.org_id || !orgType || !memberRole) {
      throw new Error('Organization membership is required');
    }

    return {
      orgId: membership.org_id,
      orgType,
      memberRole,
    };
  }

  async listBillingPlansForUser(
    userId: string,
    input?: {
      segment?: string | null;
    },
  ): Promise<BillingPlansView> {
    const requestedSegment = this.normalizeSegment(input?.segment ?? null);
    let segment: BillingSegment | null = requestedSegment;

    if (!segment) {
      try {
        const membership = await this.resolveMembershipContext(userId);
        segment = membership.orgType;
      } catch {
        segment = null;
      }
    }

    const planRows = await this.readPlanRows(segment);
    const featureRows = await this.readPlanFeatureRows(segment);

    const featuresByPlanId = new Map<string, BillingPlanView['features']>();
    for (const row of featureRows) {
      const existing = featuresByPlanId.get(row.plan_id) ?? [];
      existing.push({
        key: row.feature_key,
        label: row.feature_label,
        value: this.normalizeOptionalText(row.feature_value_text),
        limit: this.normalizeNullableInteger(row.limit_value),
        unlimited: row.is_unlimited === true,
      });
      featuresByPlanId.set(row.plan_id, existing);
    }

    const plans = planRows
      .map((row): BillingPlanView | null => {
        const rowSegment = this.normalizeSegment(row.segment);
        if (!rowSegment) {
          return null;
        }

        return {
          segment: rowSegment,
          plan_code: row.plan_code,
          display_name: row.display_name,
          tier: Math.max(0, this.normalizeInteger(row.plan_tier)),
          is_default: row.is_default === true,
          pricing: {
            currency: this.normalizeOptionalText(row.currency)?.toUpperCase() ?? 'USD',
            monthly_price_cents: this.normalizeNullableInteger(row.monthly_price_cents),
            annual_price_cents: this.normalizeNullableInteger(row.annual_price_cents),
          },
          features: featuresByPlanId.get(row.plan_id) ?? [],
        };
      })
      .filter((row): row is BillingPlanView => !!row);

    return {
      segment: segment ?? 'all',
      plans,
    };
  }

  async getCurrentPlanForOrg(orgId: string): Promise<OrganizationCurrentPlanSnapshot | null> {
    const rows = await this.prisma.$queryRaw<Array<CurrentPlanRow>>`
      select
        cp.org_id,
        cp.org_type::text as org_type,
        cp.subscription_id,
        cp.subscription_status,
        cp.billing_interval,
        cp.started_at,
        cp.current_period_start,
        cp.current_period_end,
        cp.cancel_at_period_end,
        cp.canceled_at,
        cp.plan_id,
        cp.plan_code,
        cp.plan_name,
        cp.plan_tier,
        cp.monthly_price_cents,
        cp.annual_price_cents,
        cp.currency,
        cp.is_fallback_free
      from public.org_current_subscription_plan_v1 cp
      where cp.org_id = ${orgId}::uuid
      limit 1
    `;

    const row = rows[0];
    const orgType = this.normalizeSegment(row?.org_type ?? null);
    const planId = this.normalizeOptionalText(row?.plan_id ?? null);
    const planCode = this.normalizeOptionalText(row?.plan_code ?? null);
    const planName = this.normalizeOptionalText(row?.plan_name ?? null);
    if (!row?.org_id || !orgType || !planId || !planCode || !planName) {
      return null;
    }

    return {
      org_id: row.org_id,
      org_type: orgType,
      plan: {
        id: planId,
        code: planCode,
        name: planName,
        tier: Math.max(0, this.normalizeInteger(row.plan_tier)),
        currency: this.normalizeOptionalText(row.currency)?.toUpperCase() ?? 'USD',
        monthly_price_cents: this.normalizeNullableInteger(row.monthly_price_cents),
        annual_price_cents: this.normalizeNullableInteger(row.annual_price_cents),
      },
      subscription: {
        id: this.normalizeOptionalText(row.subscription_id),
        status: this.normalizeSubscriptionStatus(row.subscription_status),
        billing_interval: this.normalizeBillingInterval(row.billing_interval),
        started_at: this.normalizeTimestamp(row.started_at),
        current_period_start: this.normalizeTimestamp(row.current_period_start),
        current_period_end: this.normalizeTimestamp(row.current_period_end),
        cancel_at_period_end: row.cancel_at_period_end === true,
        canceled_at: this.normalizeTimestamp(row.canceled_at),
        is_fallback_free: row.is_fallback_free === true,
      },
    };
  }

  async getBillingMeForUser(userId: string): Promise<BillingMeView | null> {
    const membership = await this.resolveMembershipContext(userId);
    const [currentPlan, usage] = await Promise.all([
      this.getCurrentPlanForOrg(membership.orgId),
      this.listFeatureUsageForOrg(membership.orgId),
    ]);

    if (!currentPlan) {
      return null;
    }

    return {
      ...currentPlan,
      usage,
    };
  }

  async updateBillingSubscriptionForUser(
    userId: string,
    input: UpdateBillingSubscriptionInput,
    options?: {
      allowPaidBypass?: boolean;
    },
  ): Promise<OrganizationCurrentPlanSnapshot | null> {
    const membership = await this.resolveMembershipContext(userId);
    if (membership.memberRole !== 'owner' && membership.memberRole !== 'admin') {
      throw new Error('Only organization owner or admin can update billing subscription');
    }

    const planCode = this.normalizeOptionalText(input.planCode)?.toLowerCase() ?? null;
    if (!planCode || !/^[a-z0-9_]{2,48}$/.test(planCode)) {
      throw new Error('Plan code is invalid');
    }

    const planRow = await this.readActivePlanByCode(membership.orgType, planCode);
    if (!planRow?.id) {
      throw new Error('Selected plan is not available for this organization');
    }

    const availableIntervals = await this.listPriceIntervalsForPlan(planRow.id);
    if (availableIntervals.length < 1) {
      throw new Error('Selected plan has no active pricing intervals');
    }

    const requestedInterval = this.normalizeBillingInterval(input.billingInterval ?? null);
    if (requestedInterval && !availableIntervals.includes(requestedInterval)) {
      throw new Error(
        `Selected billing interval "${requestedInterval}" is not available for this plan`,
      );
    }

    let billingInterval = requestedInterval;
    if (!billingInterval) {
      const currentPlan = await this.getCurrentPlanForOrg(membership.orgId);
      const currentInterval = currentPlan?.subscription.billing_interval;
      if (currentInterval && availableIntervals.includes(currentInterval)) {
        billingInterval = currentInterval;
      } else if (availableIntervals.includes('monthly')) {
        billingInterval = 'monthly';
      } else if (availableIntervals.includes('annual')) {
        billingInterval = 'annual';
      }
    }

    if (!billingInterval) {
      throw new Error('Unable to resolve a valid billing interval for this plan');
    }

    const amountCents = await this.readPlanPriceAmount(planRow.id, billingInterval);
    if (amountCents > 0 && options?.allowPaidBypass !== true) {
      throw new Error('Paid plans require Stripe checkout');
    }

    await this.prisma.$queryRaw`
      insert into public.org_subscription_accounts (
        org_id,
        updated_at
      )
      values (
        ${membership.orgId}::uuid,
        timezone('utc', now())
      )
      on conflict (org_id) do update
      set updated_at = timezone('utc', now())
    `;

    await this.prisma.$queryRaw`
      with now_context as (
        select
          timezone('utc', now()) as now_utc,
          case
            when ${billingInterval}::public.billing_interval = 'annual'::public.billing_interval
              then date_trunc('year', timezone('utc', now()))
            else date_trunc('month', timezone('utc', now()))
          end as period_start
      )
      insert into public.org_subscriptions as s (
        org_id,
        plan_id,
        status,
        billing_interval,
        started_at,
        current_period_start,
        current_period_end,
        cancel_at_period_end,
        canceled_at,
        source,
        external_subscription_ref,
        metadata,
        created_at,
        updated_at
      )
      select
        ${membership.orgId}::uuid,
        ${planRow.id}::uuid,
        'active'::public.billing_subscription_status,
        ${billingInterval}::public.billing_interval,
        n.now_utc,
        n.period_start,
        case
          when ${billingInterval}::public.billing_interval = 'annual'::public.billing_interval
            then n.period_start + interval '1 year'
          else n.period_start + interval '1 month'
        end,
        false,
        null,
        'manual'::text,
        null,
        jsonb_build_object(
          'updated_by_user_id',
          ${userId}::text,
          'updated_via',
          'billing_api'
        ),
        n.now_utc,
        n.now_utc
      from now_context n
      on conflict (org_id)
      where status = any (
        array[
          'trialing'::public.billing_subscription_status,
          'active'::public.billing_subscription_status,
          'past_due'::public.billing_subscription_status,
          'paused'::public.billing_subscription_status
        ]
      )
      do update
      set
        plan_id = excluded.plan_id,
        status = excluded.status,
        billing_interval = excluded.billing_interval,
        started_at = excluded.started_at,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = false,
        canceled_at = null,
        source = excluded.source,
        external_subscription_ref = null,
        metadata = coalesce(s.metadata, '{}'::jsonb) || jsonb_build_object(
          'updated_by_user_id',
          ${userId}::text,
          'updated_via',
          'billing_api'
        ),
        updated_at = timezone('utc', now())
    `;

    await this.invalidateWorkspaceCachesForOrg(membership.orgId);
    return this.getCurrentPlanForOrg(membership.orgId);
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

  private async invalidateWorkspaceCachesForOrg(orgId: string): Promise<void> {
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

  private async readActivePlanByCode(
    segment: BillingSegment,
    planCode: string,
  ): Promise<BillingPlanCatalogLookupRow | null> {
    const rows = await this.prisma.$queryRaw<Array<BillingPlanCatalogLookupRow>>`
      select
        p.id::text as id,
        p.segment::text as segment,
        p.plan_code
      from public.billing_plan_catalog p
      where p.segment = ${segment}::public.org_type
        and p.plan_code = ${planCode}
        and p.is_active = true
      limit 1
    `;

    const row = rows[0];
    const normalizedSegment = this.normalizeSegment(row?.segment ?? null);
    const normalizedPlanCode = this.normalizeOptionalText(row?.plan_code ?? null)?.toLowerCase() ?? null;
    if (!row?.id || !normalizedSegment || !normalizedPlanCode) {
      return null;
    }

    return {
      id: row.id,
      segment: normalizedSegment,
      plan_code: normalizedPlanCode,
    };
  }

  private async listPriceIntervalsForPlan(planId: string): Promise<BillingInterval[]> {
    const rows = await this.prisma.$queryRaw<Array<BillingPlanPriceIntervalRow>>`
      select distinct pp.billing_interval::text as billing_interval
      from public.billing_plan_prices pp
      where pp.plan_id = ${planId}::uuid
      order by pp.billing_interval::text asc
    `;

    return rows
      .map((row) => this.normalizeBillingInterval(row.billing_interval))
      .filter((row): row is BillingInterval => !!row);
  }

  private async readPlanPriceAmount(planId: string, billingInterval: BillingInterval): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ amount_cents: number | string | null }>>`
      select pp.amount_cents
      from public.billing_plan_prices pp
      where pp.plan_id = ${planId}::uuid
        and pp.billing_interval = ${billingInterval}::public.billing_interval
      limit 1
    `;

    return Math.max(0, this.normalizeInteger(rows[0]?.amount_cents));
  }

  private async listFeatureUsageForOrg(orgId: string): Promise<BillingFeatureUsageSnapshot[]> {
    const rows = await this.prisma.$queryRaw<Array<FeatureUsageRow>>`
      select
        c.feature_key,
        c.usage_count,
        c.period_start,
        c.period_end
      from public.org_feature_usage_counters c
      where c.org_id = ${orgId}::uuid
        and current_date between c.period_start and c.period_end
      order by c.feature_key asc
    `;

    return rows
      .map((row): BillingFeatureUsageSnapshot | null => {
        const featureKey = this.normalizeOptionalText(row.feature_key);
        const periodStart = this.normalizeDate(row.period_start);
        const periodEnd = this.normalizeDate(row.period_end);
        if (!featureKey || !periodStart || !periodEnd) {
          return null;
        }

        return {
          feature_key: featureKey,
          usage_count: Math.max(0, this.normalizeInteger(row.usage_count)),
          period_start: periodStart,
          period_end: periodEnd,
        };
      })
      .filter((row): row is BillingFeatureUsageSnapshot => !!row);
  }

  private async readPlanRows(segment: BillingSegment | null): Promise<BillingPlanRow[]> {
    if (segment) {
      return this.prisma.$queryRaw<Array<BillingPlanRow>>`
        select
          p.id::text as plan_id,
          p.segment::text as segment,
          p.plan_code,
          p.display_name,
          p.plan_tier,
          p.is_default,
          max(
            case
              when pp.billing_interval = 'monthly'::public.billing_interval
                then pp.amount_cents
            end
          )::integer as monthly_price_cents,
          max(
            case
              when pp.billing_interval = 'annual'::public.billing_interval
                then pp.amount_cents
            end
          )::integer as annual_price_cents,
          coalesce(max(pp.currency), 'USD') as currency
        from public.billing_plan_catalog p
        left join public.billing_plan_prices pp on pp.plan_id = p.id
        where p.segment = ${segment}::public.org_type
          and p.is_active = true
          and p.is_public = true
        group by
          p.id,
          p.segment,
          p.plan_code,
          p.display_name,
          p.plan_tier,
          p.is_default
        order by p.plan_tier asc, p.plan_code asc
      `;
    }

    return this.prisma.$queryRaw<Array<BillingPlanRow>>`
      select
        p.id::text as plan_id,
        p.segment::text as segment,
        p.plan_code,
        p.display_name,
        p.plan_tier,
        p.is_default,
        max(
          case
            when pp.billing_interval = 'monthly'::public.billing_interval
              then pp.amount_cents
          end
        )::integer as monthly_price_cents,
        max(
          case
            when pp.billing_interval = 'annual'::public.billing_interval
              then pp.amount_cents
          end
        )::integer as annual_price_cents,
        coalesce(max(pp.currency), 'USD') as currency
      from public.billing_plan_catalog p
      left join public.billing_plan_prices pp on pp.plan_id = p.id
      where p.is_active = true
        and p.is_public = true
      group by
        p.id,
        p.segment,
        p.plan_code,
        p.display_name,
        p.plan_tier,
        p.is_default
      order by p.segment asc, p.plan_tier asc, p.plan_code asc
    `;
  }

  private async readPlanFeatureRows(segment: BillingSegment | null): Promise<BillingPlanFeatureRow[]> {
    if (segment) {
      return this.prisma.$queryRaw<Array<BillingPlanFeatureRow>>`
        select
          pf.plan_id::text as plan_id,
          pf.feature_key,
          pf.feature_label,
          pf.feature_value_text,
          pf.limit_value,
          pf.is_unlimited
        from public.billing_plan_features pf
        join public.billing_plan_catalog p on p.id = pf.plan_id
        where p.segment = ${segment}::public.org_type
          and p.is_active = true
          and p.is_public = true
        order by p.plan_tier asc, pf.sort_order asc, pf.feature_key asc
      `;
    }

    return this.prisma.$queryRaw<Array<BillingPlanFeatureRow>>`
      select
        pf.plan_id::text as plan_id,
        pf.feature_key,
        pf.feature_label,
        pf.feature_value_text,
        pf.limit_value,
        pf.is_unlimited
      from public.billing_plan_features pf
      join public.billing_plan_catalog p on p.id = pf.plan_id
      where p.is_active = true
        and p.is_public = true
      order by p.segment asc, p.plan_tier asc, pf.sort_order asc, pf.feature_key asc
    `;
  }
}
