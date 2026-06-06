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

/** `Authorization: Bearer <token>` 헤더에서 토큰만 추출. 없으면 null. */
export function getBearerToken(authorizationHeader?: string | null): string | null {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  return m ? m[1]! : null;
}

export type { TokenClaims } from './types.js';
export { AuthError } from './types.js';
