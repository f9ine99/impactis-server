-- Normalized onboarding details: one row per (user, organization_type), details stored as JSONB.
-- Run from impactis-server: psql $DATABASE_URL -f prisma/migrations/add_user_onboarding_details.sql

CREATE TABLE IF NOT EXISTS public.user_onboarding_details (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  organization_type text NOT NULL CHECK (organization_type IN ('startup', 'investor', 'advisor')),
  details jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (user_id, organization_type)
);

CREATE INDEX IF NOT EXISTS user_onboarding_details_user_id_idx
  ON public.user_onboarding_details (user_id);

COMMENT ON TABLE public.user_onboarding_details IS 'Onboarding form details per user and org type (company name, website, stage, industry, pitch, etc.).';
