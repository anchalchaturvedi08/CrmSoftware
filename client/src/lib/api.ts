/**
 * API client.
 *
 * One place that knows how to talk to the server: attaching the token,
 * refreshing it when it expires, and turning the server's error envelope into
 * something a screen can display. No page calls `fetch` directly.
 *
 * ## Token storage
 *
 * The server returns tokens in the response body, not as httpOnly cookies, so
 * the client has to hold them. They are kept in `localStorage` so a page
 * reload does not sign the user out.
 *
 * The trade-off is worth stating: a script running on this origin could read
 * them. That is acceptable for an internal operations tool whose users are
 * staff, served from our own origin with no third-party scripts, and the
 * access token lives only fifteen minutes. If this ever becomes
 * customer-facing, move to httpOnly cookies. Recorded in DECISIONS.md.
 */

const BASE = '/api';
const STORAGE_KEY = 'cooler-crm.session';

export type Role = 'ADMIN' | 'SERVICE_CENTER_OWNER' | 'TECHNICIAN';

export interface SessionUser {
  id: string;
  name: string;
  role: Role;
  mobile: string;
  serviceCenterId?: string;
  mustChangePassword: boolean;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

/** The server's error envelope, as sent by `http/errors.ts`. */
export interface FieldIssue {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: FieldIssue[];

  constructor(status: number, code: string, message: string, issues: FieldIssue[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  /** The message for one field, for showing beside its input. */
  issueFor(field: string): string | undefined {
    return this.issues.find((issue) => issue.field === field)?.message;
  }
}

/* ---- Session persistence ----------------------------------------------- */

type Listener = (session: Session | null) => void;
const listeners = new Set<Listener>();

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    /* Corrupt storage should sign the user out, not crash the app. */
    return null;
  }
}

export function saveSession(session: Session | null): void {
  if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(STORAGE_KEY);

  for (const listener of listeners) listener(session);
}

export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Other tabs of the app share the stored session, so a sign-in, sign-out or
 * renewal in one is passed on to this tab's listeners too.
 *
 * Without it, a tab left open keeps its previous user's screens and cached
 * data after someone else signs in from another tab — while its requests
 * already go out with the new person's token. The browser fires `storage` only
 * in the *other* tabs, so this never echoes a tab's own change back to it.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== localStorage) return;
    /* A null key means storage was cleared outright. */
    if (event.key !== STORAGE_KEY && event.key !== null) return;

    const session = loadSession();
    for (const listener of listeners) listener(session);
  });
}

/**
 * Ends this device's session on the server. Best effort, by design.
 *
 * Signing out must be instant and must work with no signal — the phone may be
 * about to change hands. So this never waits and never fails: the request is
 * fired and forgotten, `keepalive` lets it finish even if the page closes
 * straight after, and any failure is ignored because the tokens are already
 * gone from this device. If it never arrives, the server-side session simply
 * lapses when its refresh token expires.
 */
export function endServerSession(refreshToken: string): void {
  try {
    fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* A browser can refuse a keepalive request outright; signing out goes on. */
  }
}

/* ---- Refresh ----------------------------------------------------------- */

/**
 * How renewing the session went.
 *
 * Two kinds of failure, and they must not be confused:
 *
 *  - **rejected** — the server looked at the refresh token and said no
 *    (password changed, account or service center deactivated, signed out,
 *    token expired). The session is over and the person has to sign in again.
 *  - **unavailable** — the server could not be asked: no signal, a server
 *    restarting, a gateway error, the page closing mid-request. Nothing is known
 *    about the session, so it is kept, and the request fails as a connection
 *    problem that can simply be retried.
 *
 * Treating both as "signed out" logged technicians out in the field over a
 * single dropped mobile connection (found in the walkthrough, DECISIONS.md
 * section 29).
 */
type RefreshOutcome =
  | { status: 'renewed'; session: Session }
  | { status: 'rejected' }
  | { status: 'unavailable' };

/**
 * A refresh already in flight.
 *
 * When the access token expires, every request that was waiting on it fails
 * with 401 at roughly the same moment. Without this, each would fire its own
 * refresh — five concurrent refreshes for one expiry — so they share one.
 */
let refreshing: Promise<RefreshOutcome> | null = null;

async function refreshSession(): Promise<RefreshOutcome> {
  const current = loadSession();
  if (!current) return { status: 'rejected' };

  refreshing ??= (async (): Promise<RefreshOutcome> => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });

      /* Only a definite answer about the token ends the session. */
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        saveSession(null);
        return { status: 'rejected' };
      }
      if (!response.ok) return { status: 'unavailable' };

      const body = (await response.json()) as Session;
      const next: Session = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        user: body.user,
      };
      saveSession(next);
      return { status: 'renewed', session: next };
    } catch {
      return { status: 'unavailable' };
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

/**
 * Thrown when the session could not be renewed for want of a connection.
 *
 * A `TypeError` mentioning "fetch" is what browsers throw for a failed
 * request, so screens show their usual "could not reach the server" message
 * and TanStack Query retries it, exactly as for any other dropped request.
 */
const connectionLost = () => new TypeError('Failed to fetch: could not renew the session');

/* ---- Requests ---------------------------------------------------------- */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the Authorization header — for login itself. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${BASE}${path}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    /* Empty filters are omitted rather than sent as `status=`, which the
       server would reject as an invalid enum value. */
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }

  const search = params.toString();
  return search ? `${url}?${search}` : url;
}

async function send(path: string, options: RequestOptions, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined
      ? {
          body:
            options.body instanceof FormData ? options.body : JSON.stringify(options.body),
        }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function toError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; issues?: FieldIssue[] };
    };
    return new ApiError(
      response.status,
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? `Request failed (${response.status})`,
      body.error?.issues ?? [],
    );
  } catch {
    return new ApiError(response.status, 'UNKNOWN', `Request failed (${response.status})`);
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = options.anonymous ? null : loadSession();
  let response = await send(path, options, session?.accessToken);

  /* One transparent retry after a refresh. A second 401 means the session is
     genuinely over — revoked by a password change, or the account
     deactivated — so the user is signed out rather than looped. If the
     refresh could not reach the server, the session is kept and this fails as
     a connection problem instead. */
  if (response.status === 401 && session && !options.anonymous) {
    const outcome = await refreshSession();
    if (outcome.status === 'unavailable') throw connectionLost();
    if (outcome.status === 'renewed') {
      response = await send(path, options, outcome.session.accessToken);
    }
  }

  if (!response.ok) {
    const error = await toError(response);
    if (response.status === 401 && !options.anonymous) saveSession(null);
    throw error;
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Fetches a protected file as a Blob.
 *
 * Attachment files need the Authorization header, which an `<img src>` cannot
 * send — so images are fetched here and shown from an object URL instead.
 */
export async function fetchBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const options: RequestOptions = signal ? { signal } : {};
  const session = loadSession();
  let response = await send(path, options, session?.accessToken);

  if (response.status === 401 && session) {
    const outcome = await refreshSession();
    if (outcome.status === 'unavailable') throw connectionLost();
    if (outcome.status === 'renewed') response = await send(path, options, outcome.session.accessToken);
  }

  if (!response.ok) throw await toError(response);
  return response.blob();
}

/** Downloads a file response (report exports, attachments) to disk. */
export async function download(path: string, query?: RequestOptions['query']): Promise<void> {
  const session = loadSession();
  let response = await send(path, { ...(query ? { query } : {}) }, session?.accessToken);

  if (response.status === 401 && session) {
    const outcome = await refreshSession();
    if (outcome.status === 'unavailable') throw connectionLost();
    if (outcome.status === 'renewed') {
      response = await send(path, { ...(query ? { query } : {}) }, outcome.session.accessToken);
    }
  }

  if (!response.ok) throw await toError(response);

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download';

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  /* In the document, and revoked a moment later: Firefox ignores a click on a
     detached link, and revoking straight away can cancel the download before
     the browser has read the file. */
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
