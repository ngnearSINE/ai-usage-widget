import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { grokUsageFromBilling, readGrokAuth, GROK_TEXT } from '../src/services/grok-cli-client.js'
import { serviceModel, paceWarning, pickWindow } from '../src/common/usage-model.js'
import type { AccountConfig } from '../src/common/types.js'

const acc: AccountConfig = { id: 'local-grok', name: 'Grok', provider: 'xai', enabled: true }
// 2026-10-26 실제 응답 모양(값만 바꿈)
const weekly = { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-22T02:14:00.181+00:00', end: '2026-10-29T02:14:00.181+00:00' },
  creditUsagePercent: 12.6, isUnifiedBillingUser: true, billingPeriodStart: '2026-10-22T02:14:00.181+00:00', billingPeriodEnd: '2026-10-29T02:14:00.181+00:00' } }
const noMonthly = { config: { monthlyLimit: { val: 0 }, used: { val: 0 }, billingPeriodEnd: '2026-11-01T00:00:00+00:00' } }
const monthly = { config: { monthlyLimit: { val: 2000 }, used: { val: 580 }, billingPeriodEnd: '2026-11-01T00:00:00+00:00' } }

test('월간 크레딧이 없으면 주간 전용 카드가 된다', () => {
  const u = grokUsageFromBilling(acc, noMonthly, weekly)
  assert.equal(u.isWeeklyOnly, true)
  assert.equal(u.primaryKind, undefined)
  assert.equal(u.primaryQuota.percentUsed, 13)
  assert.equal(u.primaryQuota.resetTime, '2026-10-29T02:14:00.181+00:00')
  const m = serviceModel(u, Date.parse('2026-10-26T00:00:00Z'))
  assert.equal(m.w5, undefined)
  assert.equal(m.ww?.label, '주간')
})

test('월간 크레딧이 있으면 첫 칸이 월간, 큰 숫자는 주간이다', () => {
  const u = grokUsageFromBilling(acc, monthly, weekly)
  assert.equal(u.primaryKind, 'monthly')
  assert.equal(u.primaryQuota.percentLeft, 71)
  const m = serviceModel(u, Date.parse('2026-10-26T00:00:00Z'))
  assert.equal(m.w5?.label, '월간')
  assert.equal(m.w5?.period, 'monthly')
  assert.equal(m.w5?.key, '5h') // 저장된 설정 키는 그대로
  assert.equal(pickWindow(m, 'weekly').main.label, '주간')
})

test('주간 기간 시작 직후 사용률이 빠지면 0%로, 둘 다 없으면 오류', () => {
  const fresh = { config: { ...weekly.config, creditUsagePercent: undefined } }
  assert.equal(grokUsageFromBilling(acc, null, fresh).primaryQuota.percentUsed, 0)
  assert.throws(() => grokUsageFromBilling(acc, noMonthly, { config: {} }), { message: GROK_TEXT.unavailable })
})

test('월간 페이스는 30일 주기로 계산한다', () => {
  const now = Date.parse('2026-10-16T00:00:00Z') // 주기 절반쯤
  const u = grokUsageFromBilling(acc, { config: { monthlyLimit: { val: 100 }, used: { val: 90 }, billingPeriodEnd: '2026-10-31T00:00:00Z' } }, null)
  const w = serviceModel(u, now).w5!
  assert.equal(w.expectedLeft, 50)
  assert.equal(paceWarning(w), true)
})

test('auth.json에서 토큰과 만료 시각만 읽는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-'))
  const file = path.join(dir, 'auth.json')
  fs.writeFileSync(file, JSON.stringify({ 'https://auth.x.ai::client': { key: 'tok', auth_mode: 'oidc', expires_at: '2026-10-26T14:25:49.175741900Z', email: '한글' } }))
  assert.deepEqual(readGrokAuth(file), { key: 'tok', expiresAt: Date.parse('2026-10-26T14:25:49.175Z') })
  fs.writeFileSync(file, '{}')
  assert.equal(readGrokAuth(file), null)
  assert.equal(readGrokAuth(path.join(dir, 'none.json')), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Grok 토큰 대신 갱신: 만료되고 10분이 지난 항목만, 받은 토큰을 같은 항목에 다시 쓴다', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const { refreshGrokTokenIfExpired, grokNeedsRelogin, grokNextEntry } = await import('../src/services/grok-token-refresh.js')
  const { setRefreshEnabled } = await import('../src/services/token-refresh.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-grok-')), file = path.join(dir, 'auth.json')
  const entry = (expiresInMs: number) => ({ key: 'OLD', refresh_token: 'R1', expires_at: new Date(Date.now() + expiresInMs).toISOString(), email: 'me@x', oidc_issuer: 'https://auth.example', oidc_client_id: 'cid' })
  const realFetch = globalThis.fetch
  const calls: string[] = []
  let reply: () => Response = () => new Response(JSON.stringify({ access_token: 'NEW', refresh_token: 'R2', expires_in: 21600 }), { status: 200 })
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push(String(url))
    if (String(url).endsWith('openid-configuration')) return new Response(JSON.stringify({ token_endpoint: 'https://auth.example/oauth2/token' }), { status: 200 })
    assert.match(String(init?.body), /grant_type=refresh_token&refresh_token=R1&client_id=cid/)
    return reply()
  }) as typeof fetch
  setRefreshEnabled(true)
  try {
    // 아직 유효하면 건드리지 않는다
    fs.writeFileSync(file, JSON.stringify({ 'https://auth.example::cid': entry(3600e3) }))
    assert.equal(await refreshGrokTokenIfExpired(file), 'fresh')
    // 만료 5분: 아직 CLI가 갱신할 수 있는 시간이라 기다린다
    fs.writeFileSync(file, JSON.stringify({ 'https://auth.example::cid': entry(-5 * 60e3) }))
    assert.equal(await refreshGrokTokenIfExpired(file), 'wait')
    assert.equal(calls.length, 0)
    // 만료 20분: 대신 갱신해 같은 항목에 다시 쓴다(다른 필드는 그대로)
    fs.writeFileSync(file, JSON.stringify({ 'https://auth.example::cid': entry(-20 * 60e3), other: { keep: 1 } }))
    assert.equal(await refreshGrokTokenIfExpired(file), 'refreshed')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    const e = saved['https://auth.example::cid']
    assert.equal(e.key, 'NEW'); assert.equal(e.refresh_token, 'R2'); assert.equal(e.email, 'me@x'); assert.deepEqual(saved.other, { keep: 1 })
    assert.ok(Date.parse(e.expires_at) > Date.now() + 5 * 3600e3)
    // 갱신 토큰이 무효면 '다시 로그인'
    reply = () => new Response('{"error":"invalid_grant"}', { status: 400 })
    fs.writeFileSync(file, JSON.stringify({ 'https://auth.example::cid': entry(-20 * 60e3) }))
    assert.equal(await refreshGrokTokenIfExpired(file), 'failed')
    assert.equal(grokNeedsRelogin(file), true)
  } finally {
    setRefreshEnabled(false); globalThis.fetch = realFetch
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(grokNextEntry({ refresh_token: 'A' }, { access_token: 'B', expires_in: 60 }, 0).refresh_token, 'A', '새 갱신 토큰이 없으면 원래 것을 둔다')
})
