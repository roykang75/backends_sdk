import type { TokenClaims } from './types.js';
import { AuthError } from './types.js';

export interface VerifyOptions {
  /** auth 서비스 base URL (예: https://backends-auth-dev.oiio.xyz) */
  url: string;
  /** 프로젝트 ref */
  ref: string;
  /** publishable 키 (서버에서도 apikey 헤더로 필요) */
  publishableKey: string;
}

/**
 * 소비자 백엔드에서 backends가 발급한 access token을 검증한다.
 *
 * JWT_SECRET은 backends만 보유하므로 로컬 검증을 직접 구현하지 말고(흔한 보안 실수)
 * 이 함수로 auth 서비스 verify 엔드포인트에 위임한다.
 * 유효하면 claim을 반환, 무효/만료면 AuthError(status 401)를 throw.
 */
export async function verifyToken(token: string, opts: VerifyOptions): Promise<TokenClaims> {
  const base = opts.url.replace(/\/$/, '');
  const res = await fetch(`${base}/auth/v1/${opts.ref}/verify`, {
    headers: { authorization: `Bearer ${token}`, apikey: opts.publishableKey },
  });
  if (!res.ok) {
    throw new AuthError('invalid or expired token', res.status);
  }
  const body = (await res.json()) as { data: TokenClaims };
  return body.data;
}

export interface AdminOptions {
  /** auth 서비스 base URL */
  url: string;
  /** 프로젝트 ref */
  ref: string;
  /** secret 키(bk_sec_). 서버 환경변수에서만. 절대 브라우저로 노출 금지. */
  secretKey: string;
}

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  oauthProvider?: string | null;
  createdAt?: string | number | null;
}

export interface AdminClient {
  listUsers(opts?: { limit?: number; offset?: number }): Promise<{ users: AdminUser[]; total: number }>;
  getUser(id: string): Promise<AdminUser>;
  createUser(creds: { email: string; password: string }): Promise<AdminUser>;
  /** 초대 메일 발송(비밀번호 없이 유저 생성). 수락 페이지에서 exchangeCodeForSession → updateUser 로 비밀번호 설정. */
  inviteUser(email: string, opts?: { redirectTo?: string }): Promise<{ userId: string; email: string }>;
  deleteUser(id: string): Promise<void>;
}

/**
 * 서버 전용 관리 클라이언트. secret 키로 프로젝트 유저를 관리한다.
 * 절대 브라우저 코드에서 import/사용하지 말 것(secret 키 노출).
 */
export function createAdminClient(opts: AdminOptions): AdminClient {
  const base = opts.url.replace(/\/$/, '');
  const root = `${base}/auth/v1/${opts.ref}/admin`;

  async function call(path: string, init: { method: string; body?: unknown }): Promise<{ data: Record<string, unknown> }> {
    // content-type은 본문이 있을 때만. 본문 없는 GET/DELETE에 붙이면
    // Fastify가 "empty JSON body"로 400을 낸다.
    const headers: Record<string, string> = { apikey: opts.secretKey };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${root}${path}`, {
      method: init.method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const msg = typeof json.error === 'string' ? json.error : `admin request failed (${res.status})`;
      throw new AuthError(msg, res.status);
    }
    return json as { data: Record<string, unknown> };
  }

  return {
    async listUsers(o = {}) {
      const q = new URLSearchParams();
      if (o.limit != null) q.set('limit', String(o.limit));
      if (o.offset != null) q.set('offset', String(o.offset));
      const qs = q.toString();
      const r = await call(`/users${qs ? '?' + qs : ''}`, { method: 'GET' });
      return r.data as unknown as { users: AdminUser[]; total: number };
    },
    async getUser(id) {
      const r = await call(`/users/${encodeURIComponent(id)}`, { method: 'GET' });
      return (r.data as { user: AdminUser }).user;
    },
    async createUser(creds) {
      const r = await call('/users', { method: 'POST', body: creds });
      return (r.data as { user: AdminUser }).user;
    },
    async inviteUser(email, opts = {}) {
      const r = await call('/invite', {
        method: 'POST',
        body: { email, ...(opts.redirectTo ? { redirect_to: opts.redirectTo } : {}) },
      });
      return r.data as unknown as { userId: string; email: string };
    },
    async deleteUser(id) {
      await call(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}

/** `Authorization: Bearer <token>` 헤더에서 토큰만 추출. 없으면 null. */
export function getBearerToken(authorizationHeader?: string | null): string | null {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  return m ? m[1]! : null;
}

export type { TokenClaims } from './types.js';
export { AuthError } from './types.js';
