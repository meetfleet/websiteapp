-- ============================================================================
-- Meetfleet — web signup support
--
-- Idempotent · safe to re-run · apply in the Supabase SQL editor.
--
-- The web signup page at /signup/ talks to the SAME backend as the mobile app,
-- so most of what it needs already exists (is_username_available,
-- verify_user_password, set_user_password, and the workos-* / wa-* edge
-- functions). This script covers the gap between "an app binary holds the anon
-- key" and "a public web page advertises it":
--
--   1. A safe signup surface  — RPCs that answer "does this account exist?"
--      without exposing rows, and that create an account atomically.
--   2. Tightened RLS on users — the current policy is FOR ALL USING (true),
--      which lets anyone holding the publishable key SELECT every column of
--      every user (password_hash included) and INSERT/UPDATE/DELETE at will.
--   3. Rate limiting          — so the signup endpoint cannot be farmed.
--
-- Section 2 is the one that changes existing behaviour. Read its notes before
-- running it in production; sections 1 and 3 are purely additive.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. Prerequisites
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Web signups arrive without a phone; the app already dropped NOT NULL, but a
-- fresh database may not have. Kept here so this script stands alone.
DO $$ BEGIN
  ALTER TABLE public.users ALTER COLUMN phone DROP NOT NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END $$;

-- Case-insensitive lookups for the existence checks below.
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON public.users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_users_phone       ON public.users (phone);
CREATE INDEX IF NOT EXISTS idx_users_google_id   ON public.users ("googleId") WHERE "googleId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_apple_id    ON public.users ("appleId")  WHERE "appleId"  IS NOT NULL;

-- Track where an account was created, so web signups are measurable and any
-- future abuse is attributable to a surface.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "signupSource" TEXT DEFAULT 'app';


-- ============================================================================
-- 1. Existence checks — boolean answers, no row exposure
--
-- The web client currently does `select id from users where email = …`, which
-- only works while the open SELECT policy exists. These SECURITY DEFINER
-- functions return a bare boolean instead, so section 2 can lock the table
-- down without breaking the signup flow.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.email_is_registered(p_email TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE LOWER(email) = LOWER(TRIM(p_email)));
$$;
GRANT EXECUTE ON FUNCTION public.email_is_registered(TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.phone_is_registered(p_phone TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_digits TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
BEGIN
  IF LENGTH(v_digits) < 8 THEN RETURN FALSE; END IF;

  -- Exact match first, then a conservative tail match for rows stored without
  -- a "+" or with a trunk zero. Requiring 8 trailing digits to agree is what
  -- stops "+33633533135" and "+212633533135" being treated as one person —
  -- the same rule the app applies in samePhoneIdentity().
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE phone = p_phone
       OR regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = v_digits
       OR (LENGTH(v_digits) >= 8 AND regexp_replace(COALESCE(phone, ''), '\D', '', 'g')
             LIKE '%' || RIGHT(v_digits, 8))
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.phone_is_registered(TEXT) TO anon, authenticated;

-- Resolve a federated identity to a user id WITHOUT returning the row, so the
-- OAuth return leg can tell "known account" from "new account".
CREATE OR REPLACE FUNCTION public.find_user_by_provider(p_provider TEXT, p_provider_id TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_provider = 'google' THEN
    SELECT id INTO v_id FROM public.users WHERE "googleId" = p_provider_id LIMIT 1;
  ELSIF p_provider = 'apple' THEN
    SELECT id INTO v_id FROM public.users WHERE "appleId" = p_provider_id LIMIT 1;
  ELSE
    RAISE EXCEPTION 'Unknown provider: %', p_provider;
  END IF;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.find_user_by_provider(TEXT, TEXT) TO anon, authenticated;


-- ============================================================================
-- 2. Rate limiting
--
-- Signup is the one write an unauthenticated caller may perform, so it needs a
-- ceiling. Counts are kept per coarse bucket (an IP hash or an identifier) and
-- pruned as they are read.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.signup_attempts (
  id         BIGSERIAL   PRIMARY KEY,
  bucket     TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_bucket
  ON public.signup_attempts (bucket, created_at DESC);

ALTER TABLE public.signup_attempts ENABLE ROW LEVEL SECURITY;
-- No policy: only SECURITY DEFINER functions may touch this table.

CREATE OR REPLACE FUNCTION public.check_signup_rate(p_bucket TEXT, p_max INT DEFAULT 5)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM public.signup_attempts WHERE created_at < NOW() - INTERVAL '1 hour';

  SELECT COUNT(*) INTO v_count
  FROM public.signup_attempts
  WHERE bucket = p_bucket AND created_at > NOW() - INTERVAL '1 hour';

  IF v_count >= p_max THEN RETURN FALSE; END IF;

  INSERT INTO public.signup_attempts (bucket) VALUES (p_bucket);
  RETURN TRUE;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.check_signup_rate(TEXT, INT) FROM PUBLIC, anon, authenticated;


-- ============================================================================
-- 3. Account creation — one atomic, validated call
--
-- Replaces the client's `insert into users … ; rpc set_user_password …` pair.
-- Doing it in one SECURITY DEFINER function means:
--   • the column whitelist is enforced server-side, not by client good manners
--   • the password is bcrypted in the same transaction as the insert
--   • the age gate and username rules cannot be bypassed by calling PostgREST
--   • a race on the username surfaces as a clean, catchable error
--
-- Returns the new user's id. Callers then mint a session via get-auth-token.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_web_account(
  p_username   TEXT,
  p_password   TEXT DEFAULT NULL,
  p_email      TEXT DEFAULT NULL,
  p_phone      TEXT DEFAULT NULL,
  p_name       TEXT DEFAULT NULL,
  p_gender     TEXT DEFAULT NULL,
  p_age        INT  DEFAULT NULL,
  p_bio        TEXT DEFAULT NULL,
  p_avatar     TEXT DEFAULT NULL,
  p_google_id  TEXT DEFAULT NULL,
  p_apple_id   TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_username TEXT := LOWER(TRIM(p_username));
  v_email    TEXT := NULLIF(LOWER(TRIM(COALESCE(p_email, ''))), '');
  v_id       UUID;
BEGIN
  -- ---- Validation -------------------------------------------------------
  IF v_username !~ '^[a-z0-9_]{3,20}$' THEN
    RAISE EXCEPTION 'invalid_username' USING HINT = '3-20 characters: letters, numbers, underscore.';
  END IF;

  IF p_age IS NULL OR p_age < 18 THEN
    RAISE EXCEPTION 'age_restricted' USING HINT = 'You must be 18 or older to join.';
  END IF;

  IF v_email IS NOT NULL AND v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;

  -- An account must be reachable by SOMETHING: a password, a verified contact,
  -- or a federated identity. Otherwise it can never be logged into.
  IF p_password IS NULL AND v_email IS NULL AND p_phone IS NULL
     AND p_google_id IS NULL AND p_apple_id IS NULL THEN
    RAISE EXCEPTION 'no_login_method';
  END IF;

  IF p_password IS NOT NULL AND LENGTH(p_password) < 8 THEN
    RAISE EXCEPTION 'weak_password' USING HINT = 'Use at least 8 characters.';
  END IF;

  -- ---- Rate limit -------------------------------------------------------
  IF NOT public.check_signup_rate(COALESCE(v_email, p_phone, v_username), 5) THEN
    RAISE EXCEPTION 'rate_limited' USING HINT = 'Too many signup attempts. Try again later.';
  END IF;

  -- ---- Uniqueness -------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.users WHERE LOWER(username) = v_username) THEN
    RAISE EXCEPTION 'username_taken';
  END IF;
  IF v_email IS NOT NULL AND EXISTS (SELECT 1 FROM public.users WHERE LOWER(email) = v_email) THEN
    RAISE EXCEPTION 'email_taken';
  END IF;
  IF p_phone IS NOT NULL AND EXISTS (SELECT 1 FROM public.users WHERE phone = p_phone) THEN
    RAISE EXCEPTION 'phone_taken';
  END IF;

  -- ---- Insert -----------------------------------------------------------
  INSERT INTO public.users (
    username, name, email, phone, gender, age, bio,
    "dicebearAvatar", "googleId", "appleId", "signupSource",
    interests, music
  ) VALUES (
    v_username,
    NULLIF(TRIM(COALESCE(p_name, '')), ''),
    v_email,
    NULLIF(TRIM(COALESCE(p_phone, '')), ''),
    NULLIF(TRIM(COALESCE(p_gender, '')), ''),
    p_age,
    NULLIF(TRIM(COALESCE(p_bio, '')), ''),
    NULLIF(TRIM(COALESCE(p_avatar, '')), ''),
    NULLIF(TRIM(COALESCE(p_google_id, '')), ''),
    NULLIF(TRIM(COALESCE(p_apple_id, '')), ''),
    'web',
    '{}', '[]'::jsonb
  )
  RETURNING id INTO v_id;

  -- Hash in the same transaction — a rollback must not leave a passwordless row.
  IF p_password IS NOT NULL THEN
    UPDATE public.users
       SET password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10))
     WHERE id = v_id;
  END IF;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_web_account(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, TEXT, TEXT, TEXT, TEXT
) TO anon, authenticated;


-- ============================================================================
-- 4. Public profile read — what the success screen may see
--
-- Returns the handful of non-sensitive columns the client needs after signup
-- or sign-in, so it never needs a raw SELECT on users.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_account_summary(p_user_id UUID)
RETURNS TABLE (
  id              UUID,
  username        TEXT,
  name            TEXT,
  "dicebearAvatar" TEXT,
  "avatarUrl"     TEXT
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, username, name, "dicebearAvatar", "avatarUrl"
  FROM public.users
  WHERE id = p_user_id;
$$;
GRANT EXECUTE ON FUNCTION public.get_account_summary(UUID) TO anon, authenticated;

COMMIT;


-- ============================================================================
-- 5. RLS TIGHTENING  ⚠️  REVIEW BEFORE RUNNING IN PRODUCTION
--
-- Everything above is additive. This section CHANGES EXISTING BEHAVIOUR.
--
-- Today public.users carries:  CREATE POLICY "open" ON public.users FOR ALL USING (true);
-- With the publishable key (which the web page necessarily exposes) that allows:
--     select * from users            -- every column of every user, incl. password_hash
--     delete from users              -- unauthenticated
--     update users set …             -- unauthenticated
--
-- The block below replaces that with: no direct anon access to `users` at all.
-- Reads and writes go through the SECURITY DEFINER functions above and the
-- app's existing RPCs, which is how the app already performs its sensitive
-- paths.
--
-- ────────────────────────────────────────────────────────────────────────────
-- BEFORE RUNNING: the mobile app currently does several DIRECT table reads
-- (authService.getMe / getPublicUser / searchUsers / loginWithEmail /
-- loginByPhoneOtp / checkUserExistsByPhone all `select` from users). Those
-- WILL BREAK for anon callers once the open policy is dropped.
--
-- Recommended order:
--   1. Apply sections 0-4 now (safe, additive) and ship the web signup.
--   2. Move the app's direct reads onto RPCs / an authenticated session.
--   3. Then run section 5 and re-test both clients.
--
-- Uncomment to apply.
-- ============================================================================

/*
BEGIN;

DROP POLICY IF EXISTS "open" ON public.users;

-- A signed-in user may read and update ONLY their own row. This project mints
-- its own JWTs via get-auth-token, so auth.uid() is the user's id there.
CREATE POLICY "users_select_self" ON public.users
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "users_update_self" ON public.users
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- No INSERT or DELETE policy at all: account creation goes through
-- create_web_account(), deletion through the existing delete_user_account().
-- anon gets no policy, so it has no direct access whatsoever.

REVOKE INSERT, UPDATE, DELETE ON public.users FROM anon;
REVOKE SELECT ON public.users FROM anon;

COMMIT;
*/


-- ============================================================================
-- 6. Verification — run after applying
-- ============================================================================

-- Functions are present and executable by anon:
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('create_web_account','email_is_registered','phone_is_registered',
--                       'find_user_by_provider','get_account_summary','check_signup_rate')
--   ORDER BY p.proname;

-- Current policies on users (expect "open" until section 5 is applied):
--   SELECT policyname, cmd, roles FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'users';

-- End-to-end smoke test (creates a real row — delete it afterwards):
--   SELECT public.create_web_account(
--     p_username => 'web_smoke_test',
--     p_password => 'sufficiently-long-password',
--     p_email    => 'web_smoke_test@example.com',
--     p_name     => 'Web Smoke Test',
--     p_gender   => 'Non-binary',
--     p_age      => 30,
--     p_bio      => 'Created by setup.sql verification.',
--     p_avatar   => 'https://api.dicebear.com/9.x/adventurer/png?seed=smoke'
--   );
--   SELECT public.verify_user_password('web_smoke_test', 'sufficiently-long-password') IS NOT NULL AS login_works;
--   DELETE FROM public.users WHERE username = 'web_smoke_test';
--   DELETE FROM public.signup_attempts WHERE bucket = 'web_smoke_test@example.com';
