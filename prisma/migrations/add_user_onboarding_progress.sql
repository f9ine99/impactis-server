-- Normalized onboarding progress: one row per (user, organization_type).
-- Run from impactis-server: psql $DATABASE_URL -f prisma/migrations/add_user_onboarding_progress.sql

CREATE TABLE IF NOT EXISTS public.user_onboarding_progress (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  organization_type text NOT NULL CHECK (organization_type IN ('startup', 'investor', 'advisor')),
  total_stages smallint NOT NULL DEFAULT 6 CHECK (total_stages > 0 AND total_stages <= 20),
  completed_stages smallint NOT NULL DEFAULT 0 CHECK (completed_stages >= 0 AND completed_stages <= total_stages),
  is_completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (user_id, organization_type)
);

CREATE INDEX IF NOT EXISTS user_onboarding_progress_user_id_idx
  ON public.user_onboarding_progress (user_id);

COMMENT ON TABLE public.user_onboarding_progress IS 'Onboarding stage progress per user and org type (e.g. 3 of 6 completed).';
