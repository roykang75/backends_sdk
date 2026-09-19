import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminClient } from '../dist/server.js';

test('inviteUser 는 secret 키로 admin/invite 를 부른다', async () => {
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ success: true, data: { userId: 'u1', email: 'i@x.test' } }), { status: 201 }); };
  const r = await createAdminClient({ url: 'https://auth.test', ref: 'r1', secretKey: 'bk_sec' }).inviteUser('i@x.test', { redirectTo: 'https://s.test/welcome' });
  assert.deepEqual(r, { userId: 'u1', email: 'i@x.test' });
  assert.equal(seen.url, 'https://auth.test/auth/v1/r1/admin/invite');
  assert.equal(seen.init.headers.apikey, 'bk_sec');
  assert.deepEqual(JSON.parse(seen.init.body), { email: 'i@x.test', redirect_to: 'https://s.test/welcome' });
});
