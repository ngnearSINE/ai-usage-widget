import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cursorUsageFromSummary, readCursorToken } from '../src/services/cursor-client.js'
import { copilotUsageFromUser, readPluginToken } from '../src/services/copilot-client.js'
import { geminiTier, geminiUsageFromQuota } from '../src/services/gemini-cli-client.js'
import type { AccountConfig } from '../src/common/types.js'

const acc = (provider: AccountConfig['provider']): AccountConfig => ({ id: `t-${provider}`, name: '', provider, enabled: true })

test('Cursor: 이번 결제 주기의 사용률과 결제일, 플랜', () => {
  const u = cursorUsageFromSummary(acc('cursor'), {
    billingCycleEnd: '2026-11-01T00:00:00.000Z', membershipType: 'pro', isUnlimited: false,
    individualUsage: { plan: { enabled: true, used: 4000, limit: 16159, totalPercentUsed: 24.7 }, onDemand: { enabled: true, used: 1234 } },
  })
  assert.equal(u.primaryKind, 'monthly')
  assert.equal(u.primaryQuota.percentUsed, 25)
  assert.equal(u.primaryQuota.resetTime, '2026-11-01T00:00:00.000Z')
  assert.equal(u.plan, 'Pro')
  assert.match(u.tier!, /추가 사용 \$12\.34/)
  // 사용률이 없으면 사용액/한도(센트)로
  assert.equal(cursorUsageFromSummary(acc('cursor'), { individualUsage: { plan: { used: 50, limit: 200 } } }).primaryQuota.percentUsed, 25)
  assert.throws(() => cursorUsageFromSummary(acc('cursor'), {}))
})

test('Cursor: 상태 DB에서 cursorAuth/accessToken 뒤의 JWT를, 만료가 늦은 것으로 읽는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-cursor-'))
  const jwt = (exp: number) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'google-oauth2|user_ABC', exp })).toString('base64url')}.c2ln`
  fs.writeFileSync(path.join(dir, 'state.vscdb'), Buffer.from(`\x00junk cursorAuth/accessToken\x01${jwt(100)}\x00 more`, 'latin1'))
  fs.writeFileSync(path.join(dir, 'state.vscdb-wal'), Buffer.from(`cursorAuth/accessToken${jwt(200)}`, 'latin1'))
  try {
    const t = readCursorToken(dir)!
    assert.equal(t.userId, 'user_ABC')
    assert.equal(t.expiresAt, 200e3)
    assert.equal(readCursorToken(path.join(dir, 'none')), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Copilot: 한도가 있는 것 중 프리미엄 → 채팅 순으로, 이번 달 리셋', () => {
  const snap = (remaining: number, entitlement: number, extra = {}) => ({ remaining, entitlement, percent_remaining: entitlement ? remaining / entitlement * 100 : 0, unlimited: false, ...extra })
  // 무료 플랜: 프리미엄 몫이 0이라 채팅이 첫 칸
  const free = copilotUsageFromUser(acc('copilot'), { login: 'me', access_type_sku: 'free_limited_copilot', copilot_plan: 'individual', quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
    quota_snapshots: { premium_interactions: snap(0, 0), chat: snap(150, 200), completions: snap(2000, 2000) } })
  assert.equal(free.plan, 'Free')
  assert.equal(free.primaryKind, 'monthly')
  assert.equal(free.primaryQuota.percentUsed, 25)
  assert.match(free.tier!, /채팅 150\/200 남음/)
  const pro = copilotUsageFromUser(acc('copilot'), { copilot_plan: 'individual', access_type_sku: 'copilot_pro', quota_snapshots: { premium_interactions: snap(270, 300), chat: snap(0, 0, { unlimited: true }) } })
  assert.equal(pro.plan, 'Pro')
  assert.equal(pro.primaryQuota.percentUsed, 10)
  assert.match(copilotUsageFromUser(acc('copilot'), { quota_snapshots: { chat: { unlimited: true } } }).tier!, /무제한/)
})

test('Copilot: 편집기 플러그인 로그인 파일에서 github.com 토큰을 읽는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-copilot-'))
  const f = path.join(dir, 'apps.json')
  fs.writeFileSync(f, JSON.stringify({ 'github.com:Iv1.abc': { user: 'me', oauth_token: 'TOKEN' } }))
  try { assert.equal(readPluginToken([path.join(dir, 'none.json'), f]), 'TOKEN') } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Gemini: Pro 모델 중 가장 적게 남은 것이 일간 첫 칸', () => {
  const u = geminiUsageFromQuota(acc('google'), { buckets: [
    { modelId: 'gemini-2.5-pro', remainingFraction: 0.8, resetTime: '2026-10-30T07:00:00Z' },
    { modelId: 'gemini-3-pro-preview', remainingFraction: 0.6, resetTime: '2026-10-30T07:00:00Z' },
    { modelId: 'gemini-2.5-flash', remainingFraction: 0.1 },
  ] }, { plan: 'Standard' })
  assert.equal(u.primaryKind, 'daily')
  assert.equal(u.primaryQuota.percentLeft, 60)
  assert.match(u.tier!, /Pro 모델/)
  assert.equal(geminiUsageFromQuota(acc('google'), { buckets: [{ modelId: 'gemini-2.5-flash', remainingFraction: 0.3 }] }, {}).primaryQuota.percentLeft, 30)
  assert.throws(() => geminiUsageFromQuota(acc('google'), { buckets: [] }, {}))
})

test('Gemini: 개인 계정 지원 종료 표시는 Standard·유료 요금제가 아닐 때만', () => {
  const consumer = { allowedTiers: [{ id: 'standard-tier' }], ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT', tierId: 'free-tier' }] }
  assert.equal(geminiTier(consumer).consumerShutdown, true)
  assert.equal(geminiTier({ ...consumer, currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'p-1' }).consumerShutdown, false)
  assert.equal(geminiTier({ ...consumer, paidTier: { name: 'Google AI Ultra for Business' } }).plan, 'Google AI Ultra for Business')
  assert.equal(geminiTier({ cloudaicompanionProject: { id: 'p-2' } }).project, 'p-2')
})

test('요금 환산: 모델 가격 찾기와 비용 계산', async () => {
  const { priceFor, costOf, summarize, dailyCosts } = await import('../src/common/cost.js')
  const { pickPrices } = await import('../src/services/model-prices.js')
  const table = pickPrices({
    'claude-opus-5-5': { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 5e-6, cache_creation_input_token_cost_above_1hr: 8e-6 },
    'gpt-6.1-sol': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1e-7 },
    'azure/gpt-6.1-sol': { input_cost_per_token: 9, output_cost_per_token: 9 }, 'gemini-2.5-pro': { input_cost_per_token: 1, output_cost_per_token: 1 },
  })
  assert.deepEqual(Object.keys(table).sort(), ['claude-opus-5-5', 'gpt-6.1-sol'], 'Claude·OpenAI 모델만, 제공사 접두어 중복은 뺀다')
  assert.equal(priceFor('claude-opus-5-5-20261001', table), table['claude-opus-5-5'], '날짜 꼬리를 떼고 찾음')
  assert.equal(priceFor('gpt-6.1-sol-high', table), table['gpt-6.1-sol'], '앞부분이 같은 이름')
  assert.equal(priceFor('unknown-model', table), null)
  const t = { input: 1e6, output: 1e5, cacheRead: 1e6, cacheWrite5m: 1e5, cacheWrite1h: 1e5 }
  assert.ok(Math.abs(costOf(t, table['claude-opus-5-5']) - (4 + 2 + 0.2 + 0.5 + 0.8)) < 1e-9)
  const daily = { '2026-10-28': { 'claude-opus-5-5': t, mystery: t }, '2026-10-29': { 'claude-opus-5-5': { ...t, output: 0 } } }
  const s = summarize(daily, table, '2026-10-28', '2026-10-28')
  assert.ok(Math.abs(s.total - 7.5) < 1e-9)
  assert.equal(s.models.mystery.known, false)
  const pts = dailyCosts(daily, table, 2, new Date(2026, 9, 29, 12))
  assert.deepEqual(pts.map(p => p.date), ['2026-10-28', '2026-10-29'])
  assert.ok(Math.abs(pts[1].cost - 5.5) < 1e-9)
})

test('요금 환산 집계: Claude는 같은 응답을 한 번만, Codex는 누적값 차이로', async () => {
  const { CostScanner } = await import('../src/services/cost-scanner.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-cost-'))
  const claudeDir = path.join(root, 'claude'), codexDir = path.join(root, 'codex', '2026', '10', '29')
  fs.mkdirSync(claudeDir, { recursive: true }); fs.mkdirSync(codexDir, { recursive: true })
  const asst = (id: string, out: number) => JSON.stringify({ type: 'assistant', requestId: `r-${id}`, timestamp: '2026-10-29T03:00:00Z', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } } })
  fs.writeFileSync(path.join(claudeDir, 'a.jsonl'), [asst('m1', 5), asst('m1', 5), asst('m2', 7), '{"type":"user"}'].join('\n') + '\n')
  fs.writeFileSync(path.join(claudeDir, 'b.jsonl'), asst('m1', 5) + '\n')
  const tc = (input: number, cached: number, output: number) => JSON.stringify({ type: 'event_msg', timestamp: '2026-10-29T04:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } })
  const codexFile = path.join(codexDir, 'rollout.jsonl')
  fs.writeFileSync(codexFile, [JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }), tc(1000, 800, 50), tc(1000, 800, 50), tc(3000, 2500, 120)].join('\n') + '\n')
  const cacheFile = path.join(root, 'cache.json')
  try {
    const roots = () => [{ source: 'claude' as const, dir: claudeDir }, { source: 'codex' as const, dir: path.join(root, 'codex') }]
    const sc = new CostScanner(cacheFile, roots)
    await sc.scan()
    const day = new Date('2026-10-29T03:00:00Z'), key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    const c = sc.totals().claude[key]['claude-opus-5-5']
    assert.equal(c.output, 12, 'm1·m2 한 번씩')
    assert.equal(c.cacheRead, 200)
    const x = sc.totals().codex[key]['gpt-6.1-sol']
    assert.deepEqual({ input: x.input, cacheRead: x.cacheRead, output: x.output }, { input: 500, cacheRead: 2500, output: 120 })
    fs.appendFileSync(codexFile, tc(4000, 3000, 200) + '\n')
    await sc.scan()
    assert.equal(sc.totals().codex[key]['gpt-6.1-sol'].output, 200, '덧붙은 줄만 읽어 누적')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
