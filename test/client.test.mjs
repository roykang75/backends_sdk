import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthClient, AuthError } from '../dist/index.js';

const calls = [];
function stubFetch(routes) {
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const key = `${init?.method ?? 'GET'} ${u.pathname}`;
    calls.push({ key, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
    const r = routes[key];
    if (!r) return new Response(JSON.stringify({ error: 'no route ' + key }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
}
const tokens = { accessToken: 'a.eyJzdWIiOiJ1MSIsImVtYWlsIjoiYUB4LnRlc3QiLCJyb2xlIjoidXNlciJ9.c', refreshToken: 'r', expiresIn: 900, tokenType: 'Bearer' };
const client = () => createAuthClient({ url: 'https://auth.test', ref: 'r1', publishableKey: 'bk_pub', autoRefresh: false });

test('signUp: confirmation_required 면 session null, 로그인 시도 없음', async () => {
  calls.length = 0;
  stubFetch({ 'POST /auth/v1/r1/register': { body: { success: true, data: { userId: 'u1', email: 'a@x.test', role: 'user', session: null, confirmation_required: true } } } });
  const r = await client().signUp({ email: 'a@x.test', password: 'pw12345678' });
  assert.equal(r.session, null);
  assert.equal(r.confirmationRequired, true);
  assert.equal(r.user.email, 'a@x.test');
  assert.deepEqual(calls.map((c) => c.key), ['POST /auth/v1/r1/register']);
});

test('signUp: 확인 OFF 면 기존처럼 로그인까지', async () => {
  calls.length = 0;
  stubFetch({
    'POST /auth/v1/r1/register': { body: { success: true, data: { userId: 'u1', email: 'a@x.test', role: 'user' } } },
    'POST /auth/v1/r1/login': { body: { success: true, data: tokens } },
  });
  const r = await client().signUp({ email: 'a@x.test', password: 'pw12345678' });
  assert.ok(r.session);
  assert.equal(r.confirmationRequired, false);
});

test('signInWithOtp / verifyOtp / resend / updateUser 요청 형태', async () => {
  calls.length = 0;
  stubFetch({
    'POST /auth/v1/r1/otp': { body: { success: true } },
    'POST /auth/v1/r1/verify': { body: { success: true, data: tokens } },
    'POST /auth/v1/r1/resend': { body: { success: true } },
    'PATCH /auth/v1/r1/user': { body: { success: true } },
  });
  const c = client();
  await c.signInWithOtp({ email: 'a@x.test', options: { emailRedirectTo: 'https://s.test/x', shouldCreateUser: false } });
  assert.deepEqual(calls[0].body, { email: 'a@x.test', create_user: false, redirect_to: 'https://s.test/x' });
  const v = await c.verifyOtp({ email: 'a@x.test', token: '123456', type: 'magiclink' });
  assert.deepEqual(calls[1].body, { email: 'a@x.test', token: '123456', type: 'magiclink' });
  assert.equal(v.session.accessToken, tokens.accessToken);
  await c.resend({ email: 'a@x.test', type: 'signup' });
  assert.deepEqual(calls[2].body, { email: 'a@x.test', type: 'signup' });
  await c.updateUser({ password: 'new-password-1' });
  assert.equal(calls[3].headers.authorization, `Bearer ${tokens.accessToken}`);
});

test('429 는 AuthError.retryAfter, 401 은 code 를 싣는다', async () => {
  stubFetch({
    'POST /auth/v1/r1/otp': { status: 429, body: { error: 'Too many', code: 'OVER_EMAIL_SEND_RATE_LIMIT', retry_after: 42 } },
    'POST /auth/v1/r1/verify': { status: 401, body: { error: 'bad', code: 'OTP_INVALID' } },
  });
  const c = client();
  await assert.rejects(() => c.signInWithOtp({ email: 'a@x.test' }), (e) => e instanceof AuthError && e.code === 'OVER_EMAIL_SEND_RATE_LIMIT' && e.retryAfter === 42);
  await assert.rejects(() => c.verifyOtp({ email: 'a@x.test', token: '1', type: 'magiclink' }), (e) => e instanceof AuthError && e.code === 'OTP_INVALID' && e.status === 401);
});
