-- Add profile completeness percent (0-100) to profiles.
-- Run from impactis-server: psql $DATABASE_URL -f prisma/migrations/add_profile_completeness_percent.sql
-- Then: npx prisma generate
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS profile_completeness_percent smallint NULL;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_profile_completeness_percent_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_profile_completeness_percent_check
  CHECK (profile_completeness_percent IS NULL OR (profile_completeness_percent >= 0 AND profile_completeness_percent <= 100));

COMMENT ON COLUMN public.profiles.profile_completeness_percent IS 'Profile completion 0-100, updated on profile save';
