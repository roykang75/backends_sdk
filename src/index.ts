import type { AuthEvent, Session, StorageLike, User } from './types.js';
import { AuthError } from './types.js';

export interface AuthClientOptions {
  /** auth 서비스 base URL (예: https://backends-auth-dev.oiio.xyz) */
  url: string;
  /** 프로젝트 ref (대시보드에서 확인) */
  ref: string;
  /** publishable(anon) 키 — 브라우저 노출 안전 */
  publishableKey: string;
  /** 세션 저장소. 기본: 브라우저 localStorage, 없으면 메모리 */
  storage?: StorageLike;
  /** 저장 키. 기본 `backends.auth.<ref>` */
  storageKey?: string;
  /** 만료 전 자동 리프레시. 기본 true */
  autoRefresh?: boolean;
}

export interface AuthClient {
  /** 가입 후 자동 로그인까지 수행하고 세션을 반환. */
  signUp(creds: { email: string; password: string }): Promise<{ user: User; session: Session }>;
  /** 이메일/비밀번호 로그인. */
  signIn(creds: { email: string; password: string }): Promise<{ user: User; session: Session }>;
  /** OAuth 시작(공급자로 리다이렉트). 브라우저면 이동, 아니면 URL만 반환. */
  signInWithOAuth(provider: 'google' | 'github', opts?: { redirectTo?: string }): string;
  /** OAuth 복귀 시 URL의 `?code=`를 토큰으로 교환. code 없으면 null. */
  completeOAuth(): Promise<Session | null>;
  /** 현재 세션(메모리 캐시). 없으면 null. */
  getSession(): Session | null;
  /** 현재 유저. 없으면 null. */
  getUser(): User | null;
  /** 로그아웃 + 서버 refresh 토큰 폐기. */
  signOut(): Promise<void>;
  /** 인증 상태 변경 구독. 해제 함수 반환. */
  onChange(cb: (event: AuthEvent, session: Session | null) => void): () => void;
}

type Listener = (event: AuthEvent, session: Session | null) => void;

function memoryStore(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** access token payload를 디코드(검증 X — 표시용. 신뢰는 서버 verifyToken이 담당). */
function decodeJwtUser(accessToken: string): User {
  try {
    const part = accessToken.split('.')[1] ?? '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf8');
    const p = JSON.parse(json) as { sub?: string; email?: string; role?: string };
    return { id: p.sub ?? '', email: p.email ?? '', role: p.role ?? 'user' };
  } catch {
    return { id: '', email: '', role: 'user' };
  }
}

export function createAuthClient(options: AuthClientOptions): AuthClient {
  const base = options.url.replace(/\/$/, '');
  const ref = options.ref;
  const apikey = options.publishableKey;
  const autoRefresh = options.autoRefresh !== false;
  const storageKey = options.storageKey ?? `backends.auth.${ref}`;
  const storage: StorageLike =
    options.storage ??
    (typeof localStorage !== 'undefined' ? (localStorage as StorageLike) : memoryStore());

  const listeners = new Set<Listener>();
  let session: Session | null = loadSession();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  function loadSession(): Session | null {
    try {
      const raw = storage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      return null;
    }
  }

  function persist(s: Session | null): void {
    session = s;
    try {
      if (s) storage.setItem(storageKey, JSON.stringify(s));
      else storage.removeItem(storageKey);
    } catch {
      /* storage 불가 환경 무시 */
    }
    if (autoRefresh) scheduleRefresh();
  }

  function emit(event: AuthEvent): void {
    for (const l of listeners) l(event, session);
  }

  function scheduleRefresh(): void {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
    if (!session) return;
    const ms = session.expiresAt - Date.now() - 30_000; // 만료 30초 전 갱신
    if (ms <= 0) { void refresh(); return; }
    refreshTimer = setTimeout(() => { void refresh(); }, ms);
  }

  async function api(
    path: string,
    init: { method: string; body?: unknown; auth?: boolean },
  ): Promise<{ data: { accessToken: string; refreshToken: string; expiresIn: number; tokenType: string } }> {
    const headers: Record<string, string> = { apikey, 'content-type': 'application/json' };
    if (init.auth && session) headers.authorization = `Bearer ${session.accessToken}`;
    const res = await fetch(`${base}/auth/v1/${ref}${path}`, {
      method: init.method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const msg = typeof json.error === 'string' ? json.error : `request failed (${res.status})`;
      throw new AuthError(msg, res.status, typeof json.code === 'string' ? json.code : undefined);
    }
    return json as { data: { accessToken: string; refreshToken: string; expiresIn: number; tokenType: string } };
  }

  function sessionFromTokens(d: { accessToken: string; refreshToken: string; expiresIn: number }): Session {
    return {
      accessToken: d.accessToken,
      refreshToken: d.refreshToken,
      tokenType: 'Bearer',
      expiresIn: d.expiresIn,
      expiresAt: Date.now() + d.expiresIn * 1000,
      user: decodeJwtUser(d.accessToken),
    };
  }

  async function signIn(creds: { email: string; password: string }): Promise<{ user: User; session: Session }> {
    const r = await api('/login', { method: 'POST', body: creds });
    const s = sessionFromTokens(r.data);
    persist(s);
    emit('SIGNED_IN');
    return { user: s.user, session: s };
  }

  async function signUp(creds: { email: string; password: string }): Promise<{ user: User; session: Session }> {
    await api('/register', { method: 'POST', body: creds });
    return signIn(creds); // 가입 직후 바로 로그인하여 세션 확보
  }

  function signInWithOAuth(provider: 'google' | 'github', opts?: { redirectTo?: string }): string {
    const redirectTo =
      opts?.redirectTo ??
      (typeof location !== 'undefined' ? location.origin + location.pathname : '');
    // 브라우저 네비게이션은 apikey 헤더를 실을 수 없으므로 쿼리로 전달(서버가 쿼리 폴백 지원).
    const url = `${base}/auth/v1/${ref}/oauth/${provider}?apikey=${encodeURIComponent(apikey)}&return_to=${encodeURIComponent(redirectTo)}`;
    if (typeof location !== 'undefined') location.assign(url);
    return url;
  }

  async function completeOAuth(): Promise<Session | null> {
    if (typeof location === 'undefined') return null;
    const u = new URL(location.href);
    const code = u.searchParams.get('code');
    if (!code) return null;
    const r = await api('/oauth/exchange', { method: 'POST', body: { code } });
    const s = sessionFromTokens(r.data);
    persist(s);
    emit('SIGNED_IN');
    u.searchParams.delete('code'); // 주소창에서 1회용 코드 제거
    if (typeof history !== 'undefined') history.replaceState({}, '', u.toString());
    return s;
  }

  async function refresh(): Promise<void> {
    if (!session) return;
    try {
      const r = await api('/refresh', { method: 'POST', body: { refreshToken: session.refreshToken } });
      persist(sessionFromTokens(r.data));
      emit('TOKEN_REFRESHED');
    } catch {
      persist(null);
      emit('SIGNED_OUT');
    }
  }

  async function signOut(): Promise<void> {
    const rt = session?.refreshToken;
    persist(null);
    emit('SIGNED_OUT');
    if (rt) {
      try { await api('/logout', { method: 'POST', body: { refreshToken: rt } }); } catch { /* noop */ }
    }
  }

  if (autoRefresh && session) scheduleRefresh();

  return {
    signUp,
    signIn,
    signInWithOAuth,
    completeOAuth,
    getSession: () => session,
    getUser: () => session?.user ?? null,
    signOut,
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
}

export type { Session, User, AuthEvent, StorageLike } from './types.js';
export { AuthError } from './types.js';
