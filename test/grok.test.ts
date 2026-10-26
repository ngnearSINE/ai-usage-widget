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
