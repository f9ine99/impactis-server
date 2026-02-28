import { IsIn, IsOptional, IsString, IsUrl, Matches } from 'class-validator';

export type BillingSegment = 'startup' | 'investor' | 'advisor';

export type BillingInterval = 'monthly' | 'annual';

export type BillingSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'canceled'
  | 'incomplete';

export class ListBillingPlansQueryInput {
  @IsOptional()
  @IsIn(['startup', 'investor', 'advisor', 'consultant'])
  segment?: string;
}

export class UpdateBillingSubscriptionInput {
  @IsString()
  @Matches(/^[a-z0-9_]{2,48}$/)
  planCode!: string;

  @IsOptional()
  @IsIn(['monthly', 'annual'])
  billingInterval?: string | null;
}

export class BillingMutationResult {
  success!: boolean;

  message?: string | null;

  currentPlan?: OrganizationCurrentPlanSnapshot | null;
}

export class CreateStripeCheckoutSessionInput {
  @IsString()
  @Matches(/^[a-z0-9_]{2,48}$/)
  planCode!: string;

  @IsOptional()
  @IsIn(['monthly', 'annual'])
  billingInterval?: string | null;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  successUrl?: string | null;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  cancelUrl?: string | null;
}

export class CreateStripePortalSessionInput {
  @IsOptional()
  @IsUrl({ require_protocol: true })
  returnUrl?: string | null;
}

export type BillingStripeRedirectMode = 'manual_applied' | 'stripe_checkout' | 'stripe_portal';

export class BillingStripeRedirectResult {
  success!: boolean;

  message?: string | null;

  mode?: BillingStripeRedirectMode | null;

  redirectUrl?: string | null;

  currentPlan?: OrganizationCurrentPlanSnapshot | null;
}

export class BillingStripeWebhookResult {
  received!: boolean;

  message?: string | null;
}

export type BillingPlanFeatureView = {
  key: string;
  label: string;
  value: string | null;
  limit: number | null;
  unlimited: boolean;
};

export type BillingPlanView = {
  segment: BillingSegment;
  plan_code: string;
  display_name: string;
  tier: number;
  is_default: boolean;
  pricing: {
    currency: string;
    monthly_price_cents: number | null;
    annual_price_cents: number | null;
  };
  features: BillingPlanFeatureView[];
};

export type BillingPlansView = {
  segment: BillingSegment | 'all';
  plans: BillingPlanView[];
};

export type OrganizationCurrentPlanSnapshot = {
  org_id: string;
  org_type: BillingSegment;
  plan: {
    id: string;
    code: string;
    name: string;
    tier: number;
    currency: string;
    monthly_price_cents: number | null;
    annual_price_cents: number | null;
  };
  subscription: {
    id: string | null;
    status: BillingSubscriptionStatus | null;
    billing_interval: BillingInterval | null;
    started_at: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    canceled_at: string | null;
    is_fallback_free: boolean;
  };
};

export type BillingFeatureUsageSnapshot = {
  feature_key: string;
  usage_count: number;
  period_start: string;
  period_end: string;
};

export type BillingMeView = OrganizationCurrentPlanSnapshot & {
  usage: BillingFeatureUsageSnapshot[];
};
