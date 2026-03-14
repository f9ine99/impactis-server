-- Re-add foreign keys to public.users after auth schema was dropped (CASCADE removed them).
-- Run once: export $(grep -v '^#' .env.local | xargs) && psql "$DATABASE_URL" -f prisma/migrations/repoint_fks_to_public_users.sql

BEGIN;

-- Auth tables
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_userId_fkey
  FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_userId_fkey
  FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

-- Profiles (profiles.id is the user id)
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey
  FOREIGN KEY (id) REFERENCES public.users(id) ON DELETE CASCADE;

-- Org membership
ALTER TABLE public.org_members
  ADD CONSTRAINT org_members_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.org_members
  ADD CONSTRAINT org_members_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES public.users(id) ON UPDATE NO ACTION;

-- Org invites
ALTER TABLE public.org_invites
  ADD CONSTRAINT org_invites_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.org_invites
  ADD CONSTRAINT org_invites_accepted_by_fkey
  FOREIGN KEY (accepted_by) REFERENCES public.users(id) ON UPDATE NO ACTION;

-- Org lifecycle
ALTER TABLE public.org_status
  ADD CONSTRAINT org_status_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES public.users(id) ON UPDATE NO ACTION;
ALTER TABLE public.org_verifications
  ADD CONSTRAINT org_verifications_reviewed_by_fkey
  FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON UPDATE NO ACTION;

-- Org-type profiles (updated_by)
ALTER TABLE public.advisor_profiles
  ADD CONSTRAINT advisor_profiles_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES public.users(id) ON UPDATE NO ACTION;
ALTER TABLE public.investor_profiles
  ADD CONSTRAINT investor_profiles_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES public.users(id) ON UPDATE NO ACTION;
ALTER TABLE public.startup_profiles
  ADD CONSTRAINT startup_profiles_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES public.users(id) ON UPDATE NO ACTION;

-- Startup content
ALTER TABLE public.startup_posts
  ADD CONSTRAINT startup_posts_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE NO ACTION;
ALTER TABLE public.startup_posts
  ADD CONSTRAINT startup_posts_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES public.users(id) ON UPDATE NO ACTION;
ALTER TABLE public.startup_data_room_documents
  ADD CONSTRAINT startup_data_room_documents_uploaded_by_fkey
  FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON UPDATE NO ACTION;

COMMIT;
