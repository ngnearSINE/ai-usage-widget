import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateNotifications, type NotifyState } from '../src/common/notify-rules.js'
import type { AccountUsage, QuotaInfo, WidgetConfig } from '../src/common/types.js'

const H = 3600e3
const t0 = Date.parse('2026-10-26T12:00:00Z')
const q = (left: number, resetAt: number): QuotaInfo => ({ remainingFraction: left / 100, percentLeft: left, percentUsed: 100 - left, resetCountdown: '', resetTime: new Date(resetAt).toISOString() })
const usage = (left5: number, reset5: number, leftW = 80, resetW = t0 + 100 * H, status: AccountUsage['status'] = 'ready'): AccountUsage => ({
  id: 'cc', name: 'Claude Code', provider: 'claude', iconLetter: 'C', brandColor: '#dda98a', status,
  primaryQuota: q(left5, reset5), weeklyQuota: q(leftW, resetW), updatedAt: new Date(t0).toISOString(),
})
const cfg = (patch: Partial<WidgetConfig> = {}) => ({ warnPercent: 20, critPercent: 10, notifyReset: true, ...patch }) as WidgetConfig
const kinds = (r: { events: { kind: string }[] }) => r.events.map(e => e.kind)

test('주의·위험 기준은 처음 닿을 때 한 번씩만 알린다', () => {
  const reset = t0 + 4 * H
  let s: NotifyState = {}
  let r = evaluateNotifications([usage(60, reset)], cfg(), s, t0); s = r.state
  assert.deepEqual(kinds(r), [])
  r = evaluateNotifications([usage(18, reset)], cfg(), s, t0 + 10 * 60e3); s = r.state
  assert.deepEqual(kinds(r), ['warn'])
  assert.match(r.events[0].title, /Claude Code 5시간 한도 18% 남음/)
  r = evaluateNotifications([usage(15, reset)], cfg(), s, t0 + 20 * 60e3); s = r.state
  assert.deepEqual(kinds(r), [], '같은 주기 안에서는 반복하지 않는다')
  r = evaluateNotifications([usage(8, reset + 5 * 60e3)], cfg(), s, t0 + 30 * 60e3); s = r.state
  assert.deepEqual(kinds(r), ['crit'], '리셋 시각이 조금 흔들려도 같은 주기로 본다')
})

test('바로 위험으로 떨어지면 위험 알림만 보낸다', () => {
  const r = evaluateNotifications([usage(5, t0 + 2 * H)], cfg(), {}, t0)
  assert.deepEqual(kinds(r), ['crit'])
})

test('속도 주의는 부족 알림을 보내지 않은 한도에만 한 번 보낸다', () => {
  // 5시간 중 0.5시간 지남(리셋 4.5시간 뒤)인데 60% 사용 → 리셋보다 한참 먼저 바닥.
  const r = evaluateNotifications([usage(40, t0 + 4.5 * H)], cfg(), {}, t0)
  assert.deepEqual(kinds(r), ['pace'])
  const again = evaluateNotifications([usage(38, t0 + 4.5 * H)], cfg(), r.state, t0 + 5 * 60e3)
  assert.deepEqual(kinds(again), [])
})

test('빠듯했던 한도가 새 주기에 다시 채워지면 리셋 알림을 보낸다', () => {
  let r = evaluateNotifications([usage(12, t0 + H)], cfg(), {}, t0)
  assert.deepEqual(kinds(r), ['warn'])
  r = evaluateNotifications([usage(100, t0 + 6 * H)], cfg(), r.state, t0 + 1.1 * H)
  assert.deepEqual(kinds(r), ['reset'])
  // 리셋 알림을 끄면 보내지 않는다.
  const off = evaluateNotifications([usage(12, t0 + H)], cfg({ notifyReset: false }), {}, t0)
  assert.deepEqual(kinds(evaluateNotifications([usage(100, t0 + 6 * H)], cfg({ notifyReset: false }), off.state, t0 + 1.1 * H)), [])
})

test('전체 끄기·서비스별 끄기·갱신 지연 값은 알림을 만들지 않는다', () => {
  assert.deepEqual(kinds(evaluateNotifications([usage(5, t0 + 2 * H)], cfg({ notifyEnabled: false }), {}, t0)), [])
  assert.deepEqual(kinds(evaluateNotifications([usage(5, t0 + 2 * H)], cfg({ notifyMuted: ['cc:5h'] }), {}, t0)), [])
  assert.deepEqual(kinds(evaluateNotifications([usage(5, t0 + 2 * H, 80, t0 + 100 * H, 'stale')], cfg(), {}, t0)), [])
  // 꺼 둔 동안 지나간 기준은 기록만 해서, 다시 켜도 지난 일을 한꺼번에 알리지 않는다.
  const muted = evaluateNotifications([usage(5, t0 + 2 * H)], cfg({ notifyEnabled: false }), {}, t0)
  assert.deepEqual(kinds(evaluateNotifications([usage(5, t0 + 2 * H)], cfg(), muted.state, t0 + 60e3)), [])
})

test('리셋 시각이 잠깐 빠졌다 돌아와도 같은 알림을 다시 보내지 않는다', () => {
  const reset = t0 + 4 * H
  let r = evaluateNotifications([usage(18, reset)], cfg(), {}, t0)
  assert.deepEqual(kinds(r), ['warn'])
  const noReset = usage(17, reset); delete noReset.primaryQuota.resetTime
  r = evaluateNotifications([noReset], cfg(), r.state, t0 + 5 * 60e3)
  assert.deepEqual(kinds(r), [], '리셋 시각이 빠진 조회')
  r = evaluateNotifications([usage(16, reset)], cfg(), r.state, t0 + 10 * 60e3)
  assert.deepEqual(kinds(r), [], '리셋 시각이 돌아온 조회')
})

test('추정 값으로는 알리지 않는다', () => {
  const u = { ...usage(5, t0 + 2 * H), isEstimated: true }
  assert.deepEqual(kinds(evaluateNotifications([u], cfg(), {}, t0)), [])
})
