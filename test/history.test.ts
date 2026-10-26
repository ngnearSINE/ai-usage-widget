import test from 'node:test'
import assert from 'node:assert/strict'
import { addSamples, downsample, HISTORY_KEEP_MS, previewHistory } from '../src/common/history.js'
import { evaluateNotifications } from '../src/common/notify-rules.js'
import { previewUsages } from '../src/common/preview-data.js'
import type { AccountUsage, QuotaInfo, WidgetConfig } from '../src/common/types.js'

const t0 = Date.parse('2026-10-26T12:00:00Z')
const q = (left: number, resetAt = t0 + 3600e3): QuotaInfo => ({ remainingFraction: left / 100, percentLeft: left, percentUsed: 100 - left, resetCountdown: '', resetTime: new Date(resetAt).toISOString() })
const u = (left5: number, leftW: number, status: AccountUsage['status'] = 'ready', resetW = t0 + 3 * 86400e3): AccountUsage => ({ id: 'cc', name: 'Claude Code', provider: 'claude', iconLetter: 'C', brandColor: '#dda98a', status, primaryQuota: q(left5), weeklyQuota: q(leftW, resetW), updatedAt: '' })

test('같은 값은 10분에 한 번만 기록하고 30일이 지난 표본은 버린다', () => {
  let r = addSamples({}, [u(80, 60)], t0)
  assert.equal(r.store.cc.length, 1)
  r = addSamples(r.store, [u(80, 60)], t0 + 60e3)
  assert.equal(r.changed, false)
  r = addSamples(r.store, [u(79, 60)], t0 + 2 * 60e3)
  assert.equal(r.store.cc.length, 2)
  r = addSamples(r.store, [u(79, 60)], t0 + 13 * 60e3)
  assert.equal(r.store.cc.length, 3)
  // 실패·지연 값은 기록하지 않는다.
  assert.equal(addSamples(r.store, [u(10, 10, 'stale')], t0 + 20 * 60e3).store.cc.length, 3)
  const later = addSamples(r.store, [u(50, 50)], t0 + HISTORY_KEEP_MS + 15 * 60e3)
  assert.deepEqual(later.store.cc.map(p => p[1]), [50])
})

test('줄이기는 구간을 지키고 개수를 넘지 않는다', () => {
  const hist = previewHistory(previewUsages(t0), t0)
  const list = hist['local-claude-code']
  assert.ok(list.length > 300)
  const d = downsample(list, t0 - 86400e3, t0, 48)
  assert.ok(d.length <= 48 && d.length > 20)
  assert.ok(d.every(p => p[0] >= t0 - 86400e3 && p[0] <= t0))
})

test('주간 리셋이 임박했는데 많이 남았으면 한 번 안내한다', () => {
  const cfg = { warnPercent: 20, critPercent: 10 } as WidgetConfig
  const r = evaluateNotifications([u(90, 70, 'ready', t0 + 10 * 3600e3)], cfg, {}, t0)
  assert.deepEqual(r.events.map(e => e.kind), ['unused'])
  assert.deepEqual(evaluateNotifications([u(90, 70, 'ready', t0 + 10 * 3600e3)], cfg, r.state, t0 + 60e3).events, [])
  assert.deepEqual(evaluateNotifications([u(90, 70, 'ready', t0 + 10 * 3600e3)], { ...cfg, notifyUnused: false }, {}, t0).events, [])
})
