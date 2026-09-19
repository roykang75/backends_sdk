# AGENTS.md — backends-sdk 연동 지침 (AI 에이전트용)

이 문서는 Claude Code 등 코딩 에이전트가 **소비자 앱에 backends 인증을 실수 없이** 붙이기
위한 지침이다. 사람이 읽는 개요는 `README.md`. 여기서는 정확한 규칙과 복붙 스니펫만 다룬다.

## 0. 언제 이 SDK를 쓰나
- 사용자가 "backends로 로그인/회원가입 붙여줘" 류를 요청할 때.
- **raw `fetch`로 `/auth/v1/...`를 직접 호출하지 말 것.** 반드시 이 SDK를 통해라.
  (헤더 누락·토큰 저장·리프레시·OAuth 교환·JWT 검증을 직접 짜면 버그/보안 결함이 난다.)

## 1. 설치 + 필요한 값
```bash
npm install backends-sdk
```
사용자에게 3개 값을 요청하거나 환경변수로 받는다(대시보드 `/projects/<ref>` 에서 확인):
- `BACKENDS_URL` (예: `https://backends-auth-dev.oiio.xyz`)
- `BACKENDS_REF` (프로젝트 ref)
- `BACKENDS_PUBLISHABLE_KEY` (`bk_pub_…`)

> `publishableKey`는 공개 키다 → 브라우저 코드/클라이언트 env(`NEXT_PUBLIC_…`, `VITE_…`)에 둬도 된다.
> backends에는 비밀 시크릿 키를 클라이언트에 두는 개념이 없다. JWT_SECRET을 소비자 코드에
> 넣으려 하지 마라 — 존재하지 않고 필요도 없다.

## 2. 브라우저 클라이언트 (단일 인스턴스)
```ts
import { createAuthClient } from 'backends-sdk';

export const auth = createAuthClient({
  url: process.env.NEXT_PUBLIC_BACKENDS_URL!,
  ref: process.env.NEXT_PUBLIC_BACKENDS_REF!,
  publishableKey: process.env.NEXT_PUBLIC_BACKENDS_PUBLISHABLE_KEY!,
});
```
- 모듈 1개에서 만들어 **재사용**한다(요청마다 새로 만들지 말 것 — 세션/리프레시 타이머가 흩어진다).
- email/password:
```ts
await auth.signUp({ email, password });   // 확인 OFF면 자동 로그인, ON이면 session null (§3.5)
await auth.signIn({ email, password });
await auth.signOut();
const session = auth.getSession();        // null이면 미로그인
```
- 상태 반영은 `onChange` 구독으로:
```ts
const unsub = auth.onChange((event, session) => { /* UI 갱신 */ });
```

## 3. OAuth (Google/GitHub) — 2단계, 반드시 둘 다 구현
```ts
// (1) 로그인 버튼
auth.signInWithOAuth('google', { redirectTo: window.location.origin + '/auth/callback' });

// (2) redirectTo 가 가리키는 페이지에서 — 마운트 시 1회
const session = await auth.completeOAuth();  // URL의 ?code= 자동 교환, 없으면 null
```
- **흔한 실수:** (2)를 빼먹는다 → 사용자가 돌아왔는데 로그인이 안 된 상태가 된다. 반드시 콜백
  페이지에서 `completeOAuth()`를 호출하라.
- `redirectTo`는 프로젝트 **Site URL** 기준 origin이어야 허용된다.

## 3.5 이메일 인증 흐름 (가입 확인 · 매직링크/코드 · 초대 · 재설정)

메서드 이름은 Supabase와 같다. 착지 처리(`exchangeCodeForSession`)는 OAuth와 공용이다.

```ts
// 가입: 확인 요구 프로젝트면 session 이 null — "메일을 확인하세요" 화면으로.
const { session, confirmationRequired } = await auth.signUp({ email, password });
if (confirmationRequired) showCheckYourEmail();

// 매직링크/코드
await auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + '/auth/callback' } });
await auth.verifyOtp({ email, token: code, type: 'magiclink' }); // 코드 입력 UI 를 쓸 때

// 착지 페이지(/auth/callback 또는 Site URL): 링크 클릭 후 ?code= 가 붙어 온다.
try { await auth.exchangeCodeForSession(); } catch (e) { if (e.code === 'OTP_EXPIRED') showExpired(); }

// 초대 수락 페이지: 착지 후 비밀번호 설정
await auth.exchangeCodeForSession();
await auth.updateUser({ password });

// 서버(초대)
await createAdminClient({ url, ref, secretKey }).inviteUser('someone@example.com');
```

- 확인 전 `signIn` 은 403 `EMAIL_NOT_CONFIRMED` → "확인 메일 재발송" 버튼(`resend({ email, type: 'signup' })`)을 붙여라.
- 발송 계열 429 는 `AuthError.code === 'OVER_EMAIL_SEND_RATE_LIMIT'` + `retryAfter`(초) → 남은 시간을 보여주고 버튼을 잠가라.
- `verifyOtp` 실패는 401 `OTP_EXPIRED` / `OTP_INVALID` → 두 경우 문구를 나눠라.

## 4. 서버 검증 (보호된 API/페이지)
들어온 토큰을 **직접 검증하지 말고** `verifyToken`을 써라.
```ts
import { verifyToken, getBearerToken } from 'backends-sdk/server';

const token = getBearerToken(req.headers.authorization);
if (!token) { /* 401 */ }
const claims = await verifyToken(token, {
  url: process.env.BACKENDS_URL!,
  ref: process.env.BACKENDS_REF!,
  publishableKey: process.env.BACKENDS_PUBLISHABLE_KEY!,
}); // 실패 시 AuthError throw → 401로 매핑
// claims.sub = userId, claims.email, claims.role, claims.pid(projectId)
```
- Express 미들웨어 패턴:
```ts
import { verifyToken, getBearerToken, AuthError } from 'backends-sdk/server';
const requireAuth = (cfg) => async (req, res, next) => {
  try {
    const t = getBearerToken(req.headers.authorization);
    if (!t) return res.status(401).json({ error: 'unauthenticated' });
    req.user = await verifyToken(t, cfg);
    next();
  } catch (e) {
    res.status(e instanceof AuthError ? (e.status ?? 401) : 500).json({ error: 'unauthenticated' });
  }
};
```

## 5. 호출 시 인증 헤더
보호된 자체 API를 부를 때 access token을 Bearer로 실어라:
```ts
fetch('/api/secure', { headers: { Authorization: `Bearer ${auth.getSession()?.accessToken}` } });
```
(토큰 만료/리프레시는 SDK가 자동 처리하므로 직접 갱신 로직을 만들지 마라.)

## 5.5 서버 관리 (secret 키, 선택)
프로젝트 유저를 서버에서 관리해야 하면 `createAdminClient`를 써라. **secret 키(`bk_sec_`)는 서버 전용** — 브라우저에서 import 금지.
```ts
import { createAdminClient } from 'backends-sdk/server';

const admin = createAdminClient({
  url: process.env.BACKENDS_URL!,
  ref: process.env.BACKENDS_PROJECT_REF!,
  secretKey: process.env.BACKENDS_SECRET_KEY!, // 서버 env에서만
});

await admin.listUsers({ limit: 50 });
await admin.getUser(id);
await admin.createUser({ email, password }); // 이메일 인증 없이 생성
await admin.inviteUser(email, { redirectTo });  // 초대 메일 발송 → { userId, email }
await admin.deleteUser(id);
```

## 6. DO / DON'T
| ✅ DO | ❌ DON'T |
|------|---------|
| `createAuthClient`/`verifyToken` 사용 | `/auth/v1/...`에 raw `fetch` 직접 호출 |
| 클라이언트 인스턴스 1개 재사용 | 컴포넌트/요청마다 새로 생성 |
| 서버에서 `verifyToken`으로 위임 검증 | JWT를 라이브러리로 직접 디코드/검증 |
| `publishableKey`는 클라이언트, `secretKey`는 서버 전용 | secret 키를 브라우저/프론트에 노출 |
| 유저 관리는 `createAdminClient`(서버) 사용 | 클라이언트에서 admin API 호출 시도 |
| OAuth 콜백 페이지에서 `completeOAuth()` 호출 | OAuth 시작만 하고 교환 누락 |
| 토큰 저장/리프레시는 SDK에 위임 | localStorage/쿠키에 토큰 수동 저장 |
| `signUp` 의 `confirmationRequired` 분기 처리 | 가입 직후 세션이 늘 있다고 가정 |
| 착지 페이지에서 `exchangeCodeForSession()` 1회 | 한 페이지에서 두 번 호출(code는 1회용) |
| 6자리 코드는 폼 입력으로 받아 `verifyOtp` | 6자리 코드를 URL 쿼리/경로에 싣기 |
| 메일 링크는 서버가 만든 것을 그대로 사용 | `/auth/v1/:ref/confirm` 을 앱에서 직접 열기(메일 링크 전용) |
| 429 의 `retryAfter` 로 재발송 버튼 잠금 | 실패 시 즉시 재시도 루프 |

## 7. 검증(연동 후 자가 확인)
- 빌드/타입체크가 통과하는가.
- 로그인 → `auth.getSession()`이 채워지는가.
- 보호 API에 토큰 없이 호출 시 401, 유효 토큰 시 통과하는가.
- OAuth: 콜백 페이지에서 `completeOAuth()` 후 세션이 생기는가.
- 이메일 흐름: 확인 메일의 링크 → 착지 페이지에서 세션이 생기는가. 만료 링크에 전용 문구가 뜨는가.

## 8. 표면 한계 (오해 방지)
- 이 SDK는 **auth만** 한다. DB 쿼리/스토리지/리얼타임 같은 건 없다(있는 척 만들지 마라).
- `@supabase/supabase-js`가 아니다. auth 메서드 이름만 Supabase와 맞췄을 뿐, 그 밖의 supabase
  클라이언트 API(`supabase.from()...`)를 흉내내지 마라.
