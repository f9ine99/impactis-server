import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UpstashRedisCacheService } from '../cache/upstash-redis-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BillingInterval,
  BillingSegment,
  BillingStripeRedirectResult,
  BillingStripeWebhookResult,
  BillingSubscriptionStatus,
  CreateStripeCheckoutSessionInput,
  CreateStripePortalSessionInput,
} from './billing.types';
import { BillingService } from './billing.service';

type BillingMembershipContext = {
  orgId: string;
  orgType: BillingSegment;
  memberRole: 'owner' | 'admin' | 'member';
};

type PlanPriceRow = {
  plan_id: string;
  segment: string | null;
  plan_code: string;
  display_name: string;
  plan_tier: number | string | null;
  amount_cents: number | string | null;
  currency: string | null;
  billing_interval: string | null;
};

type StripeCustomerResponse = {
  id?: string;
  [key: string]: unknown;
};

type StripeCheckoutSessionResponse = {
  id?: string;
  url?: string;
  [key: string]: unknown;
};

type StripePortalSessionResponse = {
  id?: string;
  url?: string;
  [key: string]: unknown;
};

type StripeSubscriptionResponse = {
  id?: string;
  [key: string]: unknown;
};

type StripeEventPayload = {
  id?: string;
  type?: string;
  livemode?: boolean;
  data?: {
    object?: unknown;
  };
};

type StripeResolvedSubscriptionInput = {
  orgId: string;
  orgType: BillingSegment;
  planId: string;
  status: BillingSubscriptionStatus;
  billingInterval: BillingInterval;
  startedAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  externalSubscriptionRef: string;
  metadataJson: string;
  stripeCustomerRef: string | null;
};

@Injectable()
export class BillingStripeService {
  private readonly logger = new Logger(BillingStripeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: UpstashRedisCacheService,
    private readonly config: ConfigService,
    private readonly billing: BillingService,
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

    if (normalized === 'month') {
      return 'monthly';
    }

    if (normalized === 'year') {
      return 'annual';
    }

    return null;
  }

  private normalizeSubscriptionStatus(
    value: string | null | undefined,
  ): BillingSubscriptionStatus {
    const normalized = this.normalizeOptionalText(value)?.toLowerCase();
    if (normalized === 'trialing') {
      return 'trialing';
    }

    if (normalized === 'active') {
      return 'active';
    }

    if (normalized === 'past_due' || normalized === 'unpaid') {
      return 'past_due';
    }

    if (normalized === 'paused') {
      return 'paused';
    }

    if (normalized === 'canceled') {
      return 'canceled';
    }

    if (normalized === 'incomplete' || normalized === 'incomplete_expired') {
      return 'incomplete';
    }

    return 'incomplete';
  }

  private isValidUuid(value: string | null): value is string {
    if (!value) {
      return false;
    }

    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private isHttpUrl(value: string | null | undefined): value is string {
    const normalized = this.normalizeOptionalText(value);
    if (!normalized) {
      return false;
    }

    try {
      const parsed = new URL(normalized);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private asArray(value: unknown): unknown[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value;
  }

  private toIsoFromUnix(value: unknown): string | null {
    const raw = this.normalizeNullableInteger(value);
    if (raw === null || raw <= 0) {
      return null;
    }

    return new Date(raw * 1000).toISOString();
  }

  private resolveWebOrigin(): string {
    const candidates = [
      this.normalizeOptionalText(this.config.get<string>('webOrigin')),
      this.normalizeOptionalText(process.env.WEB_ORIGIN),
      this.normalizeOptionalText(process.env.NEXT_PUBLIC_SITE_URL),
      'http://localhost:3000',
    ];

    for (const candidate of candidates) {
      if (this.isHttpUrl(candidate)) {
        return candidate.replace(/\/+$/, '');
      }
    }

    return 'http://localhost:3000';
  }

  private resolveCheckoutUrls(input: {
    successUrl?: string | null;
    cancelUrl?: string | null;
  }): { successUrl: string; cancelUrl: string } {
    const base = this.resolveWebOrigin();
    const successFallback = `${base}/workspace/settings?section=settings-billing&stripe=success`;
    const cancelFallback = `${base}/workspace/settings?section=settings-billing&stripe=cancel`;

    return {
      successUrl: this.isHttpUrl(input.successUrl ?? null) ? input.successUrl!.trim() : successFallback,
      cancelUrl: this.isHttpUrl(input.cancelUrl ?? null) ? input.cancelUrl!.trim() : cancelFallback,
    };
  }

  private resolvePortalReturnUrl(input?: string | null): string {
    if (this.isHttpUrl(input ?? null)) {
      return input!.trim();
    }

    return `${this.resolveWebOrigin()}/workspace/settings?section=settings-billing`;
  }

  private getStripeSecretKey(): string {
    const value = this.normalizeOptionalText(
      this.config.get<string>('stripeSecretKey') ?? process.env.STRIPE_SECRET_KEY,
    );
    if (!value) {
      throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
    }

    return value;
  }

  private getStripeWebhookSecret(): string {
    const value = this.normalizeOptionalText(
      this.config.get<string>('stripeWebhookSecret') ?? process.env.STRIPE_WEBHOOK_SECRET,
    );
    if (!value) {
      throw new Error('Stripe webhook secret is not configured.');
    }

    return value;
  }

  private async stripeRequest<T>(
    path: string,
    method: 'GET' | 'POST',
    form?: URLSearchParams,
  ): Promise<T> {
    const secretKey = this.getStripeSecretKey();
    const url = `https://api.stripe.com${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(method === 'POST'
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      body: method === 'POST' ? (form?.toString() ?? '') : undefined,
    });

    const rawBody = await response.text();
    let payload: Record<string, unknown> | null = null;
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const stripeError = this.asRecord(payload?.error);
      const message = this.normalizeOptionalText(
        typeof stripeError?.message === 'string' ? stripeError.message : null,
      ) ?? `Stripe request failed (${response.status})`;
      throw new Error(message);
    }

    return (payload ?? {}) as T;
  }

  private async resolveBillingMembershipContext(userId: string): Promise<BillingMembershipContext> {
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
      left join public.org_status s on s.org_id = o.id
      where om.user_id = ${userId}::uuid
        and om.status = 'active'
        and coalesce(s.status::text, 'active') = 'active'
      order by om.created_at asc
      limit 1
    `;

    const row = rows[0];
    const orgType = this.normalizeSegment(row?.org_type ?? null);
    const memberRole = this.normalizeMemberRole(row?.member_role ?? null);
    if (!row?.org_id || !orgType || !memberRole) {
      throw new Error('Organization membership is required');
    }

    return {
      orgId: row.org_id,
      orgType,
      memberRole,
    };
  }

  private assertBillingEditorRole(membership: BillingMembershipContext): void {
    if (membership.memberRole !== 'owner' && membership.memberRole !== 'admin') {
      throw new Error('Only organization owner or admin can update billing settings');
    }
  }

  private async readOrganizationName(orgId: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ name: string | null }>>`
      select nullif(trim(o.name), '') as name
      from public.organizations o
      where o.id = ${orgId}::uuid
      limit 1
    `;

    return this.normalizeOptionalText(rows[0]?.name) ?? 'Impactis Organization';
  }

  private async readPlanPriceRows(
    segment: BillingSegment,
    planCode: string,
  ): Promise<PlanPriceRow[]> {
    return this.prisma.$queryRaw<Array<PlanPriceRow>>`
      select
        p.id::text as plan_id,
        p.segment::text as segment,
        p.plan_code,
        p.display_name,
        p.plan_tier,
        pp.amount_cents,
        pp.currency,
        pp.billing_interval::text as billing_interval
      from public.billing_plan_catalog p
      join public.billing_plan_prices pp on pp.plan_id = p.id
      where p.segment = ${segment}::public.org_type
        and p.plan_code = ${planCode}
        and p.is_active = true
      order by
        case
          when pp.billing_interval = 'monthly'::public.billing_interval then 0
          when pp.billing_interval = 'annual'::public.billing_interval then 1
          else 2
        end asc
    `;
  }

  private selectPlanPriceRow(
    rows: PlanPriceRow[],
    requestedInterval: BillingInterval | null,
  ): PlanPriceRow | null {
    if (rows.length < 1) {
      return null;
    }

    if (requestedInterval) {
      const requested = rows.find(
        (row) => this.normalizeBillingInterval(row.billing_interval) === requestedInterval,
      );
      if (requested) {
        return requested;
      }
    }

    const monthly = rows.find(
      (row) => this.normalizeBillingInterval(row.billing_interval) === 'monthly',
    );
    if (monthly) {
      return monthly;
    }

    const annual = rows.find(
      (row) => this.normalizeBillingInterval(row.billing_interval) === 'annual',
    );
    if (annual) {
      return annual;
    }

    return rows[0];
  }

  private async ensureSubscriptionAccount(
    orgId: string,
    billingEmail: string | null,
  ): Promise<{ customerRef: string | null; billingEmail: string | null }> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        provider_customer_ref: string | null;
        billing_email: string | null;
      }>
    >`
      insert into public.org_subscription_accounts as a (
        org_id,
        billing_email,
        updated_at
      )
      values (
        ${orgId}::uuid,
        ${billingEmail},
        timezone('utc', now())
      )
      on conflict (org_id) do update
      set
        billing_email = coalesce(excluded.billing_email, a.billing_email),
        updated_at = timezone('utc', now())
      returning
        a.provider_customer_ref,
        a.billing_email
    `;

    const row = rows[0];
    return {
      customerRef: this.normalizeOptionalText(row?.provider_customer_ref),
      billingEmail: this.normalizeOptionalText(row?.billing_email),
    };
  }

  private async updateSubscriptionAccountCustomerRef(
    orgId: string,
    customerRef: string,
    billingEmail: string | null,
  ): Promise<void> {
    await this.prisma.$queryRaw`
      insert into public.org_subscription_accounts as a (
        org_id,
        billing_email,
        provider_customer_ref,
        updated_at
      )
      values (
        ${orgId}::uuid,
        ${billingEmail},
        ${customerRef},
        timezone('utc', now())
      )
      on conflict (org_id) do update
      set
        billing_email = coalesce(excluded.billing_email, a.billing_email),
        provider_customer_ref = excluded.provider_customer_ref,
        updated_at = timezone('utc', now())
    `;
  }

  private async ensureStripeCustomerForOrg(input: {
    orgId: string;
    orgType: BillingSegment;
    orgName: string;
    userEmail: string | null;
  }): Promise<string> {
    const account = await this.ensureSubscriptionAccount(input.orgId, input.userEmail);
    if (account.customerRef) {
      return account.customerRef;
    }

    const form = new URLSearchParams();
    form.set('name', input.orgName);
    if (account.billingEmail ?? input.userEmail) {
      form.set('email', (account.billingEmail ?? input.userEmail)!);
    }
    form.set('metadata[org_id]', input.orgId);
    form.set('metadata[org_type]', input.orgType);
    form.set('metadata[app]', 'impactis');

    const created = await this.stripeRequest<StripeCustomerResponse>('/v1/customers', 'POST', form);
    const customerRef = this.normalizeOptionalText(typeof created.id === 'string' ? created.id : null);
    if (!customerRef) {
      throw new Error('Unable to provision Stripe customer');
    }

    await this.updateSubscriptionAccountCustomerRef(
      input.orgId,
      customerRef,
      account.billingEmail ?? input.userEmail,
    );
    return customerRef;
  }

  private async readActiveExternalStripeSubscriptionRef(orgId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ external_subscription_ref: string | null }>>`
      select s.external_subscription_ref
      from public.org_subscriptions s
      where s.org_id = ${orgId}::uuid
        and s.status = any (
          array[
            'trialing'::public.billing_subscription_status,
            'active'::public.billing_subscription_status,
            'past_due'::public.billing_subscription_status,
            'paused'::public.billing_subscription_status
          ]
        )
        and s.external_subscription_ref is not null
      order by s.updated_at desc
      limit 1
    `;

    const ref = this.normalizeOptionalText(rows[0]?.external_subscription_ref);
    return ref && ref.startsWith('sub_') ? ref : null;
  }

  async createCheckoutSessionForUser(input: {
    userId: string;
    userEmail?: string | null;
    checkout: CreateStripeCheckoutSessionInput;
  }): Promise<BillingStripeRedirectResult> {
    const membership = await this.resolveBillingMembershipContext(input.userId);
    this.assertBillingEditorRole(membership);

    const planCode = this.normalizeOptionalText(input.checkout.planCode)?.toLowerCase() ?? null;
    const requestedInterval = this.normalizeBillingInterval(input.checkout.billingInterval ?? null);
    if (!planCode) {
      throw new Error('Plan code is required');
    }

    const planRows = await this.readPlanPriceRows(membership.orgType, planCode);
    const selectedPlan = this.selectPlanPriceRow(planRows, requestedInterval);
    if (!selectedPlan) {
      throw new Error('Selected plan is not available for this organization');
    }

    const resolvedInterval = this.normalizeBillingInterval(selectedPlan.billing_interval) ?? 'monthly';
    const amountCents = Math.max(0, this.normalizeInteger(selectedPlan.amount_cents));
    if (amountCents <= 0) {
      const currentPlan = await this.billing.updateBillingSubscriptionForUser(input.userId, {
        planCode,
        billingInterval: resolvedInterval,
      });
      return {
        success: true,
        message: 'Subscription updated.',
        mode: 'manual_applied',
        redirectUrl: null,
        currentPlan,
      };
    }

    const orgName = await this.readOrganizationName(membership.orgId);
    const stripeCustomerRef = await this.ensureStripeCustomerForOrg({
      orgId: membership.orgId,
      orgType: membership.orgType,
      orgName,
      userEmail: this.normalizeOptionalText(input.userEmail ?? null),
    });

    const activeExternalSubscriptionRef =
      await this.readActiveExternalStripeSubscriptionRef(membership.orgId);
    if (activeExternalSubscriptionRef) {
      const portal = await this.createPortalSessionForCustomer({
        customerRef: stripeCustomerRef,
        returnUrl: this.resolvePortalReturnUrl(input.checkout.cancelUrl ?? null),
      });
      return {
        success: true,
        message:
          'Active Stripe subscription found. Redirecting to billing portal for subscription management.',
        mode: 'stripe_portal',
        redirectUrl: portal.url,
        currentPlan: null,
      };
    }

    const { successUrl, cancelUrl } = this.resolveCheckoutUrls({
      successUrl: input.checkout.successUrl,
      cancelUrl: input.checkout.cancelUrl,
    });
    const currency = this.normalizeOptionalText(selectedPlan.currency)?.toLowerCase() ?? 'usd';
    const intervalForStripe = resolvedInterval === 'annual' ? 'year' : 'month';

    const form = new URLSearchParams();
    form.set('customer', stripeCustomerRef);
    form.set('mode', 'subscription');
    form.set('success_url', successUrl);
    form.set('cancel_url', cancelUrl);
    form.set('client_reference_id', membership.orgId);
    form.set('allow_promotion_codes', 'true');
    form.set('metadata[org_id]', membership.orgId);
    form.set('metadata[org_type]', membership.orgType);
    form.set('metadata[plan_code]', planCode);
    form.set('metadata[billing_interval]', resolvedInterval);
    form.set('subscription_data[metadata][org_id]', membership.orgId);
    form.set('subscription_data[metadata][org_type]', membership.orgType);
    form.set('subscription_data[metadata][plan_code]', planCode);
    form.set('subscription_data[metadata][billing_interval]', resolvedInterval);
    form.set('line_items[0][quantity]', '1');
    form.set('line_items[0][price_data][currency]', currency);
    form.set('line_items[0][price_data][unit_amount]', amountCents.toString());
    form.set('line_items[0][price_data][recurring][interval]', intervalForStripe);
    form.set(
      'line_items[0][price_data][product_data][name]',
      `Impactis ${selectedPlan.display_name} (${membership.orgType})`,
    );

    const session = await this.stripeRequest<StripeCheckoutSessionResponse>(
      '/v1/checkout/sessions',
      'POST',
      form,
    );
    const checkoutUrl = this.normalizeOptionalText(typeof session.url === 'string' ? session.url : null);
    if (!checkoutUrl) {
      throw new Error('Unable to start Stripe checkout session');
    }

    return {
      success: true,
      message: 'Checkout session created.',
      mode: 'stripe_checkout',
      redirectUrl: checkoutUrl,
      currentPlan: null,
    };
  }

  private async createPortalSessionForCustomer(input: {
    customerRef: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const form = new URLSearchParams();
    form.set('customer', input.customerRef);
    form.set('return_url', input.returnUrl);

    const session = await this.stripeRequest<StripePortalSessionResponse>(
      '/v1/billing_portal/sessions',
      'POST',
      form,
    );
    const portalUrl = this.normalizeOptionalText(typeof session.url === 'string' ? session.url : null);
    if (!portalUrl) {
      throw new Error('Unable to create Stripe billing portal session');
    }

    return { url: portalUrl };
  }

  async createPortalSessionForUser(input: {
    userId: string;
    userEmail?: string | null;
    portal: CreateStripePortalSessionInput;
  }): Promise<BillingStripeRedirectResult> {
    const membership = await this.resolveBillingMembershipContext(input.userId);
    this.assertBillingEditorRole(membership);

    const orgName = await this.readOrganizationName(membership.orgId);
    const stripeCustomerRef = await this.ensureStripeCustomerForOrg({
      orgId: membership.orgId,
      orgType: membership.orgType,
      orgName,
      userEmail: this.normalizeOptionalText(input.userEmail ?? null),
    });
    const portal = await this.createPortalSessionForCustomer({
      customerRef: stripeCustomerRef,
      returnUrl: this.resolvePortalReturnUrl(input.portal.returnUrl ?? null),
    });

    return {
      success: true,
      message: 'Billing portal session created.',
      mode: 'stripe_portal',
      redirectUrl: portal.url,
      currentPlan: null,
    };
  }

  private verifyStripeWebhookSignature(rawPayload: string, signatureHeader: string): void {
    const webhookSecret = this.getStripeWebhookSecret();
    const signatureParts = signatureHeader
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const timestampRaw = signatureParts
      .find((part) => part.startsWith('t='))
      ?.slice('t='.length) ?? null;
    const signatures = signatureParts
      .filter((part) => part.startsWith('v1='))
      .map((part) => part.slice('v1='.length))
      .filter((part) => part.length > 0);

    const timestamp = timestampRaw ? Number.parseInt(timestampRaw, 10) : null;
    if (!timestamp || signatures.length < 1) {
      throw new Error('Stripe signature header is invalid');
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    if (Math.abs(nowEpoch - timestamp) > 300) {
      throw new Error('Stripe webhook signature timestamp is outside tolerance');
    }

    const payloadToSign = `${timestamp}.${rawPayload}`;
    const expected = createHmac('sha256', webhookSecret)
      .update(payloadToSign)
      .digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');

    const isValid = signatures.some((signature) => {
      const signatureBuffer = Buffer.from(signature, 'utf8');
      if (signatureBuffer.length !== expectedBuffer.length) {
        return false;
      }

      return timingSafeEqual(signatureBuffer, expectedBuffer);
    });

    if (!isValid) {
      throw new Error('Stripe signature mismatch');
    }
  }

  async handleWebhook(input: {
    rawBody: Buffer;
    stripeSignature: string | null;
  }): Promise<BillingStripeWebhookResult> {
    const stripeSignature = this.normalizeOptionalText(input.stripeSignature ?? null);
    if (!stripeSignature) {
      return {
        received: false,
        message: 'Missing stripe-signature header',
      };
    }

    const rawPayload = input.rawBody.toString('utf8');
    try {
      this.verifyStripeWebhookSignature(rawPayload, stripeSignature);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid webhook signature';
      return {
        received: false,
        message,
      };
    }

    let event: StripeEventPayload;
    try {
      event = JSON.parse(rawPayload) as StripeEventPayload;
    } catch {
      return {
        received: false,
        message: 'Invalid webhook payload',
      };
    }

    const eventId = this.normalizeOptionalText(event.id);
    const eventType = this.normalizeOptionalText(event.type);
    if (!eventId || !eventType) {
      return {
        received: false,
        message: 'Webhook payload missing event id or type',
      };
    }

    const inserted = await this.recordWebhookEvent(eventId, eventType, event.livemode === true, rawPayload);
    if (!inserted) {
      return {
        received: true,
        message: 'Duplicate event ignored',
      };
    }

    try {
      await this.processWebhookEvent(eventType, event.data?.object ?? null);
      return {
        received: true,
        message: 'Webhook processed',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Webhook processing failed';
      this.logger.error(`Stripe webhook processing failed: ${message}`);
      return {
        received: false,
        message,
      };
    }
  }

  private async recordWebhookEvent(
    eventId: string,
    eventType: string,
    liveMode: boolean,
    rawPayload: string,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      insert into public.billing_webhook_events (
        provider,
        event_id,
        event_type,
        livemode,
        payload,
        processed_at,
        created_at,
        updated_at
      )
      values (
        'stripe',
        ${eventId},
        ${eventType},
        ${liveMode},
        ${rawPayload}::jsonb,
        timezone('utc', now()),
        timezone('utc', now()),
        timezone('utc', now())
      )
      on conflict (provider, event_id) do nothing
      returning id
    `;

    return !!rows[0]?.id;
  }

  private async processWebhookEvent(eventType: string, payload: unknown): Promise<void> {
    if (eventType === 'checkout.session.completed') {
      const session = this.asRecord(payload);
      const subscriptionRef = this.extractSubscriptionRef(session?.subscription);
      if (subscriptionRef) {
        await this.syncStripeSubscriptionByRef(subscriptionRef, eventType);
      }
      return;
    }

    if (
      eventType === 'customer.subscription.created'
      || eventType === 'customer.subscription.updated'
      || eventType === 'customer.subscription.deleted'
    ) {
      const subscription = this.asRecord(payload);
      await this.applyStripeSubscriptionObject(subscription, eventType);
      return;
    }

    if (eventType === 'invoice.payment_failed' || eventType === 'invoice.payment_succeeded') {
      const invoice = this.asRecord(payload);
      const subscriptionRef = this.extractSubscriptionRef(invoice?.subscription);
      if (subscriptionRef) {
        await this.syncStripeSubscriptionByRef(subscriptionRef, eventType);
      }
    }
  }

  private extractSubscriptionRef(value: unknown): string | null {
    if (typeof value === 'string') {
      return this.normalizeOptionalText(value);
    }

    const row = this.asRecord(value);
    return this.normalizeOptionalText(typeof row?.id === 'string' ? row.id : null);
  }

  private async syncStripeSubscriptionByRef(
    subscriptionRef: string,
    eventType: string,
  ): Promise<void> {
    const encodedRef = encodeURIComponent(subscriptionRef);
    const subscription = await this.stripeRequest<StripeSubscriptionResponse>(
      `/v1/subscriptions/${encodedRef}?expand[]=items.data.price`,
      'GET',
    );
    await this.applyStripeSubscriptionObject(subscription as Record<string, unknown>, eventType);
  }

  private async resolveOrgIdByStripeCustomer(customerRef: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ org_id: string }>>`
      select a.org_id
      from public.org_subscription_accounts a
      where a.provider_customer_ref = ${customerRef}
      limit 1
    `;

    return this.normalizeOptionalText(rows[0]?.org_id);
  }

  private async resolveOrganizationType(orgId: string): Promise<BillingSegment | null> {
    const rows = await this.prisma.$queryRaw<Array<{ org_type: string | null }>>`
      select o.type::text as org_type
      from public.organizations o
      where o.id = ${orgId}::uuid
      limit 1
    `;

    return this.normalizeSegment(rows[0]?.org_type ?? null);
  }

  private async resolvePlanIdByCode(
    orgType: BillingSegment,
    planCode: string | null,
  ): Promise<string | null> {
    if (!planCode) {
      return null;
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      select p.id::text as id
      from public.billing_plan_catalog p
      where p.segment = ${orgType}::public.org_type
        and p.plan_code = ${planCode}
        and p.is_active = true
      limit 1
    `;

    return this.normalizeOptionalText(rows[0]?.id);
  }

  private async resolvePlanIdByPrice(input: {
    orgType: BillingSegment;
    billingInterval: BillingInterval | null;
    amountCents: number | null;
    currency: string | null;
  }): Promise<string | null> {
    if (!input.billingInterval || input.amountCents === null || !input.currency) {
      return null;
    }

    const normalizedCurrency = input.currency.toUpperCase();
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      select p.id::text as id
      from public.billing_plan_catalog p
      join public.billing_plan_prices pp on pp.plan_id = p.id
      where p.segment = ${input.orgType}::public.org_type
        and p.is_active = true
        and pp.billing_interval = ${input.billingInterval}::public.billing_interval
        and pp.amount_cents = ${input.amountCents}
        and upper(pp.currency) = ${normalizedCurrency}
      order by p.plan_tier asc
      limit 1
    `;

    return this.normalizeOptionalText(rows[0]?.id);
  }

  private async resolveFallbackFreePlanId(orgType: BillingSegment): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      select p.id::text as id
      from public.billing_plan_catalog p
      where p.segment = ${orgType}::public.org_type
        and p.plan_code = 'free'
        and p.is_active = true
      limit 1
    `;

    return this.normalizeOptionalText(rows[0]?.id);
  }

  private async ensurePlanIdForStripeSubscription(input: {
    orgType: BillingSegment;
    planCodeHint: string | null;
    billingInterval: BillingInterval | null;
    amountCents: number | null;
    currency: string | null;
  }): Promise<string> {
    const byCode = await this.resolvePlanIdByCode(input.orgType, input.planCodeHint);
    if (byCode) {
      return byCode;
    }

    const byPrice = await this.resolvePlanIdByPrice({
      orgType: input.orgType,
      billingInterval: input.billingInterval,
      amountCents: input.amountCents,
      currency: input.currency,
    });
    if (byPrice) {
      return byPrice;
    }

    const fallback = await this.resolveFallbackFreePlanId(input.orgType);
    if (!fallback) {
      throw new Error('Unable to resolve billing plan for Stripe subscription');
    }

    return fallback;
  }

  private extractStripeSubscriptionPrice(input: Record<string, unknown> | null): {
    billingInterval: BillingInterval | null;
    amountCents: number | null;
    currency: string | null;
  } {
    const items = this.asRecord(input?.items);
    const firstItem = this.asRecord(this.asArray(items?.data)[0]);
    const price = this.asRecord(firstItem?.price);
    const recurring = this.asRecord(price?.recurring);

    return {
      billingInterval: this.normalizeBillingInterval(
        typeof recurring?.interval === 'string' ? recurring.interval : null,
      ),
      amountCents: this.normalizeNullableInteger(price?.unit_amount),
      currency: this.normalizeOptionalText(
        typeof price?.currency === 'string' ? price.currency : null,
      )?.toUpperCase() ?? null,
    };
  }

  private async upsertSubscriptionFromStripe(
    input: StripeResolvedSubscriptionInput,
  ): Promise<void> {
    await this.prisma.$queryRaw`
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
      values (
        ${input.orgId}::uuid,
        ${input.planId}::uuid,
        ${input.status}::public.billing_subscription_status,
        ${input.billingInterval}::public.billing_interval,
        coalesce(${input.startedAt}::timestamptz, timezone('utc', now())),
        ${input.currentPeriodStart}::timestamptz,
        ${input.currentPeriodEnd}::timestamptz,
        ${input.cancelAtPeriodEnd},
        ${input.canceledAt}::timestamptz,
        'stripe_webhook',
        ${input.externalSubscriptionRef},
        ${input.metadataJson}::jsonb,
        timezone('utc', now()),
        timezone('utc', now())
      )
      on conflict (org_id)
      where status = any (
        array[
          'trialing'::public.billing_subscription_status,
          'active'::public.billing_subscription_status,
          'past_due'::public.billing_subscription_status,
          'paused'::public.billing_subscription_status
        ]
      )
      do update set
        plan_id = excluded.plan_id,
        status = excluded.status,
        billing_interval = excluded.billing_interval,
        started_at = excluded.started_at,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        canceled_at = excluded.canceled_at,
        source = excluded.source,
        external_subscription_ref = excluded.external_subscription_ref,
        metadata = coalesce(s.metadata, '{}'::jsonb) || excluded.metadata,
        updated_at = timezone('utc', now())
    `;
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

  private async applyStripeSubscriptionObject(
    subscriptionObject: Record<string, unknown> | null,
    eventType: string,
  ): Promise<void> {
    const subscriptionRef = this.normalizeOptionalText(
      typeof subscriptionObject?.id === 'string' ? subscriptionObject.id : null,
    );
    if (!subscriptionRef) {
      return;
    }

    const metadata = this.asRecord(subscriptionObject?.metadata);
    const planCodeHint =
      this.normalizeOptionalText(
        typeof metadata?.plan_code === 'string' ? metadata.plan_code : null,
      )?.toLowerCase() ?? null;
    const orgIdHint = this.normalizeOptionalText(
      typeof metadata?.org_id === 'string' ? metadata.org_id : null,
    );
    const customerRef = this.normalizeOptionalText(
      typeof subscriptionObject?.customer === 'string' ? subscriptionObject.customer : null,
    );

    let orgId: string | null = null;
    if (this.isValidUuid(orgIdHint)) {
      orgId = orgIdHint;
    } else if (customerRef) {
      orgId = await this.resolveOrgIdByStripeCustomer(customerRef);
    }

    if (!this.isValidUuid(orgId)) {
      this.logger.warn(`Unable to resolve org for Stripe subscription ${subscriptionRef}`);
      return;
    }

    const orgType = await this.resolveOrganizationType(orgId);
    if (!orgType) {
      this.logger.warn(`Unable to resolve org type for Stripe subscription ${subscriptionRef}`);
      return;
    }

    if (customerRef) {
      await this.updateSubscriptionAccountCustomerRef(orgId, customerRef, null);
    }

    const extractedPrice = this.extractStripeSubscriptionPrice(subscriptionObject);
    const metadataInterval = this.normalizeBillingInterval(
      typeof metadata?.billing_interval === 'string' ? metadata.billing_interval : null,
    );
    const billingInterval = extractedPrice.billingInterval ?? metadataInterval ?? 'monthly';
    const planId = await this.ensurePlanIdForStripeSubscription({
      orgType,
      planCodeHint,
      billingInterval,
      amountCents: extractedPrice.amountCents,
      currency: extractedPrice.currency,
    });

    const status = this.normalizeSubscriptionStatus(
      typeof subscriptionObject?.status === 'string' ? subscriptionObject.status : null,
    );
    const startedAt = this.toIsoFromUnix(subscriptionObject?.start_date ?? subscriptionObject?.created);
    const currentPeriodStart = this.toIsoFromUnix(subscriptionObject?.current_period_start);
    const currentPeriodEnd = this.toIsoFromUnix(subscriptionObject?.current_period_end);
    const cancelAtPeriodEnd = subscriptionObject?.cancel_at_period_end === true;
    const canceledAt = this.toIsoFromUnix(subscriptionObject?.canceled_at);

    const metadataJson = JSON.stringify({
      stripe_customer_ref: customerRef,
      stripe_status_raw: this.normalizeOptionalText(
        typeof subscriptionObject?.status === 'string' ? subscriptionObject.status : null,
      ),
      stripe_event_type: eventType,
      stripe_plan_code_hint: planCodeHint,
      stripe_price_amount_cents: extractedPrice.amountCents,
      stripe_price_currency: extractedPrice.currency,
      updated_at: new Date().toISOString(),
    });

    await this.upsertSubscriptionFromStripe({
      orgId,
      orgType,
      planId,
      status,
      billingInterval,
      startedAt,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      canceledAt,
      externalSubscriptionRef: subscriptionRef,
      metadataJson,
      stripeCustomerRef: customerRef,
    });

    await this.invalidateWorkspaceCachesForOrg(orgId);
  }
}
