/**
 * Meetfleet — web messaging: Supabase client + session.
 *
 * A browser port of mobile/services/supabase.ts and the session half of
 * mobile/services/auth.ts. Same project, same publishable key, same
 * get-auth-token contract — so a session minted by /login is exactly the one
 * the mobile client would have minted for itself.
 *
 * The app's own notion of "who is signed in" is the `user_token` storage key
 * (a bare user id), NOT a Supabase auth user. The Supabase session exists only
 * so RLS-guarded reads on `messages` and `users` succeed; it is refreshed
 * opportunistically and its absence degrades to a redirect back to /login
 * rather than a broken page.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// Same project + publishable key the app and /signup ship with. This key is
// designed to be public; every table it can reach is guarded by RLS.
export const SUPABASE_URL = 'https://sbmeuhzmghaqkclaimid.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_0Gf3FQtxmbXg5w-lxAWqKQ__5fJa-dY';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  realtime: { params: { eventsPerSecond: 12 } },
});

export const TOKEN_KEY = 'user_token';
export const USER_KEY = 'current_user';

/** The signed-in user's id, or null. Mirrors storage.getItem(TOKEN_KEY). */
export function getStoredUserId() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** The last-known user row, used to paint the UI before getMe() resolves. */
export function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function storeUser(user) {
  try {
    localStorage.setItem(TOKEN_KEY, user.id);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch { /* private mode — best effort */ }
}

export function clearStoredSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch { /* nothing to clear */ }
}

/**
 * Ensure a Supabase session exists for the stored user id.
 *
 * Two layers of deduplication, because callers arrive both concurrently and
 * sequentially:
 *
 *   • `refreshing` collapses simultaneous callers — the inbox, the realtime
 *     subscription and the first message fetch all reach here on boot, and
 *     three get-auth-token invocations would be three sessions racing to
 *     overwrite each other.
 *   • `mintedFor` collapses *later* callers. The edge function returns an
 *     access token with no refresh token, so `setSession` leaves nothing for
 *     `getSession()` to report; without this, every subsequent call would see
 *     "no session" and mint another token for a user who already has one.
 *
 * Mirrors ensureSupabaseSession() in mobile/services/auth.ts.
 */
let refreshing = null;
let mintedFor = null;

export function ensureSession() {
  if (refreshing) return refreshing;

  const userId = getStoredUserId();
  // Already minted for this exact user in this page's lifetime.
  if (userId && mintedFor === userId) return Promise.resolve(true);

  refreshing = (async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        mintedFor = userId;
        return true;
      }

      if (!userId) return false;

      const { data, error } = await supabase.functions.invoke('get-auth-token', {
        body: { userId },
      });
      if (error || !data?.token) return false;

      // The edge function mints an access token only; there is no refresh token
      // to pair with it, which is why the app passes an empty string here too.
      await supabase.auth.setSession({ access_token: data.token, refresh_token: '' });
      mintedFor = userId;
      return true;
    } catch (err) {
      console.warn('ensureSession failed:', err);
      return false;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

/**
 * Force the next ensureSession() to mint again.
 *
 * The minted token is short-lived and has no refresh token behind it, so a
 * long-lived tab will eventually be holding an expired one. Callers that see
 * an auth failure use this to recover rather than stranding the page.
 */
export function invalidateSession() {
  mintedFor = null;
}

/**
 * Load the full user row for the signed-in id.
 *
 * Falls back to the cached copy when the network or RLS says no, so a flaky
 * connection shows a stale name rather than bouncing the user to /login.
 * Mirrors authService.getMe() minus the badge/plan hydration, which this
 * surface has no use for.
 */
export async function getMe() {
  const token = getStoredUserId();
  if (!token) return null;

  await ensureSession();

  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', token)
      .single();
    if (error || !data) throw error ?? new Error('No user row');

    const { password_hash, ...safe } = data;
    storeUser(safe);
    return safe;
  } catch (err) {
    console.warn('getMe failed, falling back to cached user:', err);
    return getStoredUser();
  }
}

/** Sign out of both our own session and Supabase's, then go home. */
export async function signOut() {
  clearStoredSession();
  try {
    await supabase.auth.signOut();
  } catch { /* already gone */ }
  location.assign('/login/');
}

/** Send an unauthenticated visitor to /login, preserving where they wanted to go. */
export function requireAuth() {
  const id = getStoredUserId();
  if (id) return id;
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`/login/?next=${next}`);
  return null;
}
