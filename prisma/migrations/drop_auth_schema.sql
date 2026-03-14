-- Create public auth tables (if missing), copy from auth if it exists, repoint FKs, then drop auth schema.
-- Run once: export $(grep -v '^#' .env.local | xargs) && psql "$DATABASE_URL" -f prisma/migrations/drop_auth_schema.sql

BEGIN;

-- 1) Create public.users if not exists (Better Auth + raw_user_meta_data)
CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY,
  name text,
  email text,
  email_verified boolean DEFAULT false,
  image text,
  created_at timestamptz DEFAULT timezone('utc', now()),
  updated_at timestamptz DEFAULT timezone('utc', now()),
  raw_user_meta_data jsonb
);

-- 2) Copy auth.users -> public.users if auth schema exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users')
  THEN
    INSERT INTO public.users (id, name, email, email_verified, image, created_at, updated_at, raw_user_meta_data)
    SELECT
      id,
      name,
      email,
      COALESCE(email_verified, false),
      image,
      COALESCE(created_at, timezone('utc', now())),
      COALESCE(updated_at, timezone('utc', now())),
      raw_user_meta_data
    FROM auth.users
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      email_verified = EXCLUDED.email_verified,
      image = EXCLUDED.image,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      raw_user_meta_data = COALESCE(EXCLUDED.raw_user_meta_data, public.users.raw_user_meta_data);
  END IF;
END $$;

-- 3) Create public.accounts if not exists (no FK yet so it works before users is populated)
CREATE TABLE IF NOT EXISTS public.accounts (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" uuid NOT NULL,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL DEFAULT timezone('utc', now()),
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS accounts_userId_idx ON public.accounts("userId");

-- 4) Create public.sessions if not exists
CREATE TABLE IF NOT EXISTS public.sessions (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT timezone('utc', now()),
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_userId_idx ON public.sessions("userId");

-- 5) Copy auth.accounts -> public.accounts if auth exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'accounts')
  THEN
    INSERT INTO public.accounts (id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken",
      "accessTokenExpiresAt", "refreshTokenExpiresAt", scope, password, "createdAt", "updatedAt")
    SELECT id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken",
      "accessTokenExpiresAt", "refreshTokenExpiresAt", scope, password, "createdAt", "updatedAt"
    FROM auth.accounts
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- 6) Copy auth.sessions -> public.sessions if auth exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'sessions')
  THEN
    INSERT INTO public.sessions (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId")
    SELECT id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"
    FROM auth.sessions
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- 7) Add FKs to public.users (drop first in case they pointed to auth.users)
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_userId_fkey;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_userId_fkey
  FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_userId_fkey;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_userId_fkey
  FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

-- 8) Create verification + jwks and copy from auth if needed
CREATE TABLE IF NOT EXISTS public.verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT timezone('utc', now()),
  "updatedAt" timestamptz NOT NULL DEFAULT timezone('utc', now())
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON public.verification(identifier);

CREATE TABLE IF NOT EXISTS public.jwks (
  id text PRIMARY KEY,
  "publicKey" text NOT NULL,
  "privateKey" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "expiresAt" timestamptz
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'verification')
  THEN
    INSERT INTO public.verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
    SELECT id, identifier, value, "expiresAt", "createdAt", "updatedAt" FROM auth.verification
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'jwks')
  THEN
    INSERT INTO public.jwks (id, "publicKey", "privateKey", "createdAt", "expiresAt")
    SELECT id, "publicKey", "privateKey", "createdAt", "expiresAt" FROM auth.jwks
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- 9) Drop auth schema (Supabase leftovers)
DROP SCHEMA IF EXISTS auth CASCADE;

COMMIT;
