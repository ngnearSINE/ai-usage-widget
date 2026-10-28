import test from 'node:test'
import assert from 'node:assert/strict'
import { addUsage, buckets, dailyFromHistory, dayKey, pruneDaily, usedBetween, type DailyStore } from '../src/common/stats.js'
import type { HistoryPoint } from '../src/common/types.js'

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()

test('남은 양이 줄어든 만큼만 쓴 양으로 센다(리셋으로 늘면 0)', () => {
  assert.equal(usedBetween(80, 72), 8)
  assert.equal(usedBetween(72, 72), 0)
  assert.equal(usedBetween(5, 100), 0)
  assert.equal(usedBetween(null, 50), 0)
})

test('표본마다 그 날짜에 주간 한도 %를 더한다', () => {
  const daily: DailyStore = {}
  const p = (t: number, w: number | null): HistoryPoint => [t, null, w]
  addUsage(daily, 'a', p(at(2026, 10, 27, 9), 90), p(at(2026, 10, 27, 10), 85))
  addUsage(daily, 'a', p(at(2026, 10, 27, 10), 85), p(at(2026, 10, 27, 23), 80))
  addUsage(daily, 'a', p(at(2026, 10, 27, 23), 80), p(at(2026, 10, 28, 1), 100)) // 리셋
  addUsage(daily, 'a', p(at(2026, 10, 28, 1), 100), p(at(2026, 10, 28, 9), 97))
  assert.deepEqual(daily, { a: { '2026-10-27': 10, '2026-10-28': 3 } })
})

test('원본 기록으로 날짜별 합계를 채운다', () => {
  const store = { a: [[at(2026, 10, 1, 8), 100, 50], [at(2026, 10, 1, 9), 90, 46], [at(2026, 10, 2, 9), 80, 40]] as HistoryPoint[] }
  assert.deepEqual(dailyFromHistory(store), { a: { '2026-10-01': 4, '2026-10-02': 6 } })
})

test('1년이 지난 날짜는 버린다', () => {
  const now = at(2026, 10, 28)
  const out = pruneDaily({ a: { '2025-10-01': 5, '2026-10-27': 3 }, b: { '2024-01-01': 1 } }, now)
  assert.deepEqual(out, { a: { '2026-10-27': 3 } })
})

test('일간·주간(월요일 시작)·월간 칸으로 묶는다', () => {
  const now = at(2026, 10, 28) // 수요일
  const days = { '2026-10-26': 10, '2026-10-27': 5, '2026-10-28': 2, '2026-10-25': 7, '2026-09-30': 4 }
  const d = buckets(days, 'day', now, 3)
  assert.deepEqual(d.map(b => [b.label, b.total]), [['10/26', 10], ['10/27', 5], ['10/28', 2]])
  const w = buckets(days, 'week', now, 2)
  assert.deepEqual(w.map(b => [b.label, b.total, b.days]), [['10/19', 7, 7], ['10/26', 17, 3]])
  const m = buckets(days, 'month', now, 2)
  assert.deepEqual(m.map(b => [b.label, b.total]), [['9월', 4], ['10월', 24]])
  assert.equal(dayKey(now), '2026-10-28')
})
