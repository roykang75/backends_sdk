/** backends가 발급한 엔드유저 정보(access token claim에서 추출). */
export interface User {
  id: string;
  email: string;
  role: string;
}

/** 로그인 결과 세션. accessToken으로 API 호출, refreshToken으로 갱신. */
export interface Session {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** access token 수명(초) */
  expiresIn: number;
  /** access token 만료 시각(epoch ms) — 자동 리프레시 기준 */
  expiresAt: number;
  user: User;
}

export type AuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED';

/** 서버 verifyToken이 반환하는 검증된 claim. */
export interface TokenClaims {
  sub: string;
  email: string;
  role: string;
  /** 토큰 계층. 엔드유저는 'user' */
  tier: string;
  /** 프로젝트 id */
  pid: string;
  exp: number;
}

/** 세션 저장소(localStorage 호환 인터페이스). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 메일로 보내는 일회용 코드/링크의 종류. */
export type OtpType = 'signup' | 'magiclink' | 'invite' | 'recovery';

/** SDK 호출 실패. status는 HTTP 상태코드. */
export class AuthError extends Error {
  status?: number;
  code?: string;
  /** 발송 제한(429, code `OVER_EMAIL_SEND_RATE_LIMIT`)일 때 재시도까지 남은 초. */
  retryAfter?: number;
  constructor(message: string, status?: number, code?: string, retryAfter?: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
