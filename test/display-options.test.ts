import test from 'node:test'
import assert from 'node:assert/strict'
import { displayOf, displaySummary, setDisplay, setDisplayAll } from '../src/common/display-options.js'
import { inQuietHours } from '../src/common/notify-rules.js'
import type { WidgetConfig } from '../src/common/types.js'

const base = { showUsedPercent: false, showPace: true, showResetTime: true } as WidgetConfig

test('서비스별 값이 없으면 전체 값을 쓰고, 전체 값과 같아지면 서비스별 값을 지운다', () => {
  let c = { ...base, ...setDisplay(base, 'a', 'showPace', false) }
  assert.equal(displayOf(c, 'a').showPace, false)
  assert.equal(displayOf(c, 'b').showPace, true)
  assert.equal(displaySummary(c, ['a', 'b'], 'showPace'), 'mixed')
  c = { ...c, ...setDisplay(c, 'a', 'showPace', true) }
  assert.deepEqual(c.displayByAccount, {})
})

test('모든 서비스 일괄 변경은 그 항목의 서비스별 값을 지운다(다른 항목은 남긴다)', () => {
  let c = { ...base, ...setDisplay(base, 'a', 'showPace', false) }
  c = { ...c, ...setDisplay(c, 'a', 'showUsed', true) }
  c = { ...c, ...setDisplayAll(c, 'showPace', false) }
  assert.equal(c.showPace, false)
  assert.deepEqual(c.displayByAccount, { a: { showUsed: true } })
  assert.equal(displaySummary(c, ['a', 'b'], 'showPace'), 'off')
})

test('알림 쉬는 시간: 자정을 넘는 구간과 꺼진 경우', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 27, h, m)
  const q = { enabled: true, start: '23:00', end: '08:00' }
  assert.equal(inQuietHours(q, at(23, 30)), true)
  assert.equal(inQuietHours(q, at(7, 59)), true)
  assert.equal(inQuietHours(q, at(8, 0)), false)
  assert.equal(inQuietHours(q, at(12)), false)
  assert.equal(inQuietHours({ ...q, start: '09:00', end: '18:00' }, at(12)), true)
  assert.equal(inQuietHours({ ...q, enabled: false }, at(23, 30)), false)
  assert.equal(inQuietHours(undefined, at(23, 30)), false)
})
