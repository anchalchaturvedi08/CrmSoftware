/**
 * Authentication state for the whole app.
 *
 * The session lives in `api.ts`; this exposes it to React and keeps every
 * component in step when it changes — including when a request elsewhere
 * discovers the session has been revoked and clears it.
 *
 * It also owns one privacy rule: **cached data never outlives the person it
 * was fetched for.** Query keys say what was asked, not who asked — the Visits
 * agenda is `['visits', 'agenda', …]` for Admin and every Owner alike, since
 * the server does the scoping. Without this, an Owner signing in on a tab an
 * Admin had just signed out of was shown every centre's visits straight from
 * the cache, and on a shared phone one technician briefly saw the last one's
 * jobs (or, with no signal, kept seeing them).
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  endServerSession,
  loadSession,
  onSessionChange,
  saveSession,
  type Session,
  type SessionUser,
} from './api';

interface AuthValue {
  user: SessionUser | null;
  login: (mobile: string, password: string) => Promise<SessionUser>;
  logout: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(() => loadSession());

  /**
   * Every session change passes through here: sign-in, sign-out, a renewal,
   * a 401 anywhere clearing the session, or another tab doing any of those.
   * Listening is what turns a cleared session into a redirect to sign-in.
   *
   * The query cache is emptied whenever the person changes — signed out, or a
   * different user signed in — and kept when the same person merely renews
   * their session every few minutes. It is emptied *before* the new session
   * reaches React, so the next portal mounts with nothing from the last one.
   * A request still in flight for the previous person is cancelled with its
   * query, so its answer cannot land in the new person's cache either.
   */
  useEffect(() => {
    let cachedFor = loadSession()?.user.id ?? null;

    return onSessionChange((next) => {
      const nextUser = next?.user.id ?? null;
      if (nextUser !== cachedFor) {
        queryClient.clear();
        cachedFor = nextUser;
      }
      setSession(next);
    });
  }, [queryClient]);

  const login = useCallback(async (mobile: string, password: string) => {
    const result = await api<Session>('/auth/login', {
      method: 'POST',
      body: { mobile, password },
      anonymous: true,
    });

    saveSession({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    });

    return result.user;
  }, []);

  /**
   * Signs out here at once, then tells the server.
   *
   * Local first, so it is instant and works offline: the tokens are gone from
   * this device, and the listener above empties the cache and returns to the
   * sign-in page. The server call then ends this device's session — only this
   * one; the person stays signed in elsewhere — so a copy of the refresh token
   * cannot keep the session going. It is best effort and never holds up or
   * fails signing out (see `endServerSession`).
   */
  const logout = useCallback(() => {
    const ending = loadSession();
    saveSession(null);
    if (ending) endServerSession(ending.refreshToken);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ user: session?.user ?? null, login, logout }),
    [session, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/** Where each role lands after signing in. */
export function homeFor(role: SessionUser['role']): string {
  switch (role) {
    case 'ADMIN':
      return '/admin';
    case 'SERVICE_CENTER_OWNER':
      return '/center';
    case 'TECHNICIAN':
      return '/tech';
  }
}
