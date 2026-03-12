-- Manual migration: add need_advisor to startup_posts, connection_requests, connections, connection_messages
-- Run this if prisma migrate dev reports drift (e.g. existing DB not managed by migrate).

-- 1. Add need_advisor to startup_posts
ALTER TABLE public.startup_posts
  ADD COLUMN IF NOT EXISTS need_advisor boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS startup_posts_need_advisor_status_idx
  ON public.startup_posts (need_advisor, status)
  WHERE need_advisor = true AND status = 'published'::public.startup_post_status;

-- 2. Create enum for connection request status
DO $$ BEGIN
  CREATE TYPE public.connection_request_status AS ENUM ('pending', 'accepted', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 3. connection_requests table
CREATE TABLE IF NOT EXISTS public.connection_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  to_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status public.connection_request_status NOT NULL DEFAULT 'pending',
  message text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  responded_at timestamptz,
  CONSTRAINT connection_requests_from_to_unique UNIQUE (from_org_id, to_org_id)
);

CREATE INDEX IF NOT EXISTS connection_requests_to_status_idx ON public.connection_requests (to_org_id, status);
CREATE INDEX IF NOT EXISTS connection_requests_from_status_idx ON public.connection_requests (from_org_id, status);

-- 4. connections table
CREATE TABLE IF NOT EXISTS public.connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_a_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  org_b_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT connections_orgs_unique UNIQUE (org_a_id, org_b_id)
);

CREATE INDEX IF NOT EXISTS connections_org_a_idx ON public.connections (org_a_id);
CREATE INDEX IF NOT EXISTS connections_org_b_idx ON public.connections (org_b_id);

-- 5. connection_messages table
CREATE TABLE IF NOT EXISTS public.connection_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.connections(id) ON DELETE CASCADE,
  from_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS connection_messages_connection_created_idx ON public.connection_messages (connection_id, created_at ASC);
