# backends-sdk

backends 인증을 앱에 붙이기 위한 **최소 SDK** — 브라우저 클라이언트 + 서버 검증.

> backends로 만든 프로젝트의 **엔드유저 인증**(가입/로그인/세션/OAuth)을 손으로 `fetch`
> 짜지 않고 안전하게 연동하기 위한 얇은 래퍼입니다. 토큰 저장·자동 리프레시·OAuth 코드
> 교환·서버 토큰 검증처럼 **틀리기 쉬운 부분**을 안에서 처리합니다.
>
> 이건 Supabase 대체 SDK가 **아닙니다.** `auth`만 다룹니다(DB/스토리지/리얼타임 없음).
> REST API가 정본이고, 이 SDK는 그 위 얇은 레이어입니다.

## 설치

```bash
npm install backends-sdk
# 또는 github 직접
npm install github:roykang75/backends_sdk
```

요구: Node ≥ 18 (전역 `fetch` 사용). 런타임 의존성 없음.

## 필요한 값

backends 대시보드 `/projects/<ref>` 에서:
- **url** — auth 서비스 base (예: `https://backends-auth-dev.oiio.xyz`)
- **ref** — 프로젝트 ref
- **publishableKey** — `bk_pub_…` (브라우저 노출 안전한 공개 키)

> 비밀번호 리셋 메일·OAuth 리다이렉트가 앱 도메인으로 가게 하려면 대시보드에서
> **Site URL**도 설정하세요.

## 브라우저 — 로그인/세션

```ts
import { createAuthClient } from 'backends-sdk';

const auth = createAuthClient({
  url: 'https://backends-auth-dev.oiio.xyz',
  ref: 'your_project_ref',
  publishableKey: 'bk_pub_...',
});

// 가입 / 로그인
await auth.signUp({ email, password }); // 가입 확인을 켠 프로젝트면 session 이 null — 아래 참고
const { user, session } = await auth.signIn({ email, password });

// 현재 상태
auth.getSession();   // Session | null
auth.getUser();      // User | null

// 상태 변화 구독
const unsub = auth.onChange((event, session) => {
  // 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED'
});

await auth.signOut();
```

세션은 `localStorage`에 저장되고, access token은 **만료 전 자동 리프레시**됩니다.
인증된 API 호출 시 `session.accessToken`을 `Authorization: Bearer`로 보내면 됩니다.

## 브라우저 — OAuth (Google/GitHub)

```ts
// 1) 로그인 버튼: 공급자로 리다이렉트 (return_to = 돌아올 앱 URL)
auth.signInWithOAuth('google', { redirectTo: window.location.origin + '/callback' });

// 2) 돌아온 페이지(/callback)에서: URL의 ?code= 를 토큰으로 교환
const session = await auth.completeOAuth(); // code 없으면 null
```

> OAuth가 동작하려면 backends에 공급자 콜백이 등록돼 있어야 하고, `redirectTo`(=return_to)는
> 프로젝트 **Site URL** 기준으로 허용됩니다.

## 브라우저 — 이메일 인증 흐름

메일로 오는 링크/6자리 코드를 쓰는 흐름들입니다. 메서드 이름은 Supabase와 같습니다.

### 가입 확인 (프로젝트 설정으로 켬)

확인을 켜면 `signUp` 이 세션을 주지 않습니다. 확인 전 `signIn` 은 403(`EMAIL_NOT_CONFIRMED`).

```ts
const { session, confirmationRequired } = await auth.signUp({ email, password });
if (confirmationRequired) showCheckYourEmail(); // session 은 null
```

### 매직링크 + 6자리 코드

```ts
// 발송 — 링크와 코드가 함께 간다. 유저가 없으면 만든다(원치 않으면 shouldCreateUser: false)
await auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + '/auth/callback' } });

// 코드 입력 UI를 쓸 때 — 링크 대신 6자리 코드로 세션 발급
const { session } = await auth.verifyOtp({ email, token: code, type: 'magiclink' });

// 재발송 (type: 'signup' | 'magiclink' | 'invite' | 'recovery')
await auth.resend({ email, type: 'signup' });
```

### 착지 페이지 (`emailRedirectTo` 또는 Site URL)

메일 링크를 누르면 앱으로 `?code=` 를 달고 돌아옵니다. 가입 확인·매직링크·초대·비밀번호
재설정이 모두 같은 처리입니다. **한 페이지에서 한 번만** 호출하세요(코드는 1회용).

```ts
try {
  const session = await auth.exchangeCodeForSession(); // completeOAuth 와 같은 함수
} catch (e) {
  if (e.code === 'OTP_EXPIRED') showExpiredLink(); // ?error=access_denied&error_code=otp_expired
}
```

### 초대 (서버에서 발송 → 앱에서 수락)

```ts
// 서버: secret 키로 초대 메일 발송
await createAdminClient({ url, ref, secretKey }).inviteUser('someone@example.com');

// 앱의 수락 페이지: 착지 후 비밀번호 설정
await auth.exchangeCodeForSession();
await auth.updateUser({ password });
```

### 발송 제한

메일 발송 계열은 429로 막힐 수 있습니다. `AuthError.code === 'OVER_EMAIL_SEND_RATE_LIMIT'`
이고 `retryAfter`(초)가 실립니다.

```ts
try {
  await auth.resend({ email, type: 'signup' });
} catch (e) {
  if (e.code === 'OVER_EMAIL_SEND_RATE_LIMIT') showRetryIn(e.retryAfter);
}
```

## 서버 — 토큰 검증

소비자 백엔드에서 들어온 access token을 검증합니다. **JWT를 직접 검증하지 마세요**
(시크릿은 backends만 보유). 이 함수가 auth 서비스에 위임합니다.

```ts
import { verifyToken, getBearerToken } from 'backends-sdk/server';

const token = getBearerToken(req.headers.authorization);
if (!token) return res.status(401).end();

try {
  const claims = await verifyToken(token, {
    url: 'https://backends-auth-dev.oiio.xyz',
    ref: 'your_project_ref',
    publishableKey: 'bk_pub_...',
  });
  // claims: { sub, email, role, tier, pid, exp }
} catch {
  return res.status(401).end();
}
```

## API

### `createAuthClient(options) → AuthClient`
- `options`: `{ url, ref, publishableKey, storage?, storageKey?, autoRefresh? }`
- 메서드:
  - `signUp({ email, password })` → `{ user, session, confirmationRequired }` (확인 OFF면 자동 로그인, ON이면 `session: null`)
  - `signIn({ email, password })` → `{ user, session }`
  - `signInWithOtp({ email, options? })` → `void` (매직링크+코드 발송)
  - `verifyOtp({ email, token, type })` → `{ user, session }`
  - `resend({ email, type })` → `void`
  - `updateUser({ password })` → `void` (로그인 상태 필요)
  - `signInWithOAuth(provider, { redirectTo? })` → URL(브라우저면 이동)
  - `completeOAuth()` / `exchangeCodeForSession()` → `Session | null` (같은 함수)
  - `getSession()` → `Session | null`
  - `getUser()` → `User | null`
  - `signOut()` → `Promise<void>`
  - `onChange(cb)` → 해제 함수

### `verifyToken(token, { url, ref, publishableKey }) → Promise<TokenClaims>` (`backends-sdk/server`)
무효/만료 시 `AuthError`(`status` 포함) throw.

### `getBearerToken(headerValue) → string | null` (`backends-sdk/server`)

### `createAdminClient({ url, ref, secretKey }) → AdminClient` (`backends-sdk/server`)
**서버 전용.** secret 키(`bk_sec_`)로 프로젝트 유저를 관리. 브라우저에서 쓰지 말 것.
- `listUsers({ limit?, offset? })` → `{ users, total }`
- `getUser(id)` → `AdminUser`
- `createUser({ email, password })` → `AdminUser` (이메일 인증 없이 생성)
- `inviteUser(email, { redirectTo? })` → `{ userId, email }` (초대 메일 발송)
- `deleteUser(id)` → `void`

```ts
import { createAdminClient } from 'backends-sdk/server';
const admin = createAdminClient({ url, ref, secretKey: process.env.BACKENDS_SECRET_KEY! });
const { users } = await admin.listUsers();
```

## 동작 방식

- 모든 요청에 `apikey: <publishableKey>` 헤더 자동 첨부 (잊을 일 없음).
- 로그인/리프레시/교환 응답의 토큰으로 `Session` 구성, `expiresAt` 계산.
- access token payload를 디코드해 `user`를 채움(표시용; 신뢰는 서버 `verifyToken`).
- 만료 30초 전 자동 리프레시. 실패 시 `SIGNED_OUT` 방출.

## 라이선스

MIT
