import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseLayout, formOf, pickWindow, quotaWindow, richTier, serviceModel, severity, worstWindow, WINDOW_5H } from '../src/common/usage-model.js'
import { previewUsages } from '../src/common/preview-data.js'
import type { AccountUsage, QuotaInfo } from '../src/common/types.js'

const now = Date.parse('2026-10-26T12:00:00Z')
const q = (left: number, resetInMs?: number): QuotaInfo => ({ remainingFraction: left / 100, percentLeft: left, percentUsed: 100 - left, resetCountdown: '', ...(resetInMs === undefined ? {} : { resetTime: new Date(now + resetInMs).toISOString() }) })

test('리셋 주기 경과로 페이스 눈금과 소진 예상을 계산한다', () => {
  // 5시간 중 2시간 41분 남음 → 경과 약 46%, 9% 남았으면 지금 속도로 리셋 전에 바닥난다.
  const w = quotaWindow(q(9, 2 * 3600e3 + 41 * 60e3), '5h', now)
  assert.equal(w.expectedLeft, 54)
  assert.equal(w.runsOut, true)
  assert.ok(w.toEmptyMs! < w.resetMs!)
  // 리셋 시각을 모르면 페이스·소진 예상을 만들지 않는다.
  const unknown = quotaWindow(q(40), '5h', now)
  assert.equal(unknown.elapsed, null); assert.equal(unknown.expectedLeft, null); assert.equal(unknown.runsOut, false)
  // 리셋 시각이 주기보다 멀리 잡혀도 주기 길이로 제한한다.
  assert.equal(quotaWindow(q(50, WINDOW_5H * 3), '5h', now).resetMs, WINDOW_5H)
})

test('주간 전용 계정과 한도가 하나뿐인 계정은 있는 한도로 표시한다', () => {
  const base = previewUsages(now)[0]
  const weeklyOnly: AccountUsage = { ...base, isWeeklyOnly: true, primaryQuota: q(30, 86400e3), weeklyQuota: undefined }
  const m = serviceModel(weeklyOnly, now)
  assert.equal(m.w5, undefined); assert.equal(m.ww?.left, 30)
  // 5시간 기준을 골라도 주간 한도로 대신한다.
  assert.equal(pickWindow(m, '5h').main.key, 'weekly')
  assert.equal(pickWindow(m, '5h').other, undefined)
})

test('여유 부족 강조는 남은 양 기준이며 소진 예상만 있어도 주의로 본다', () => {
  const base = previewUsages(now)[1]
  const crit = serviceModel({ ...base, primaryQuota: q(8, 3600e3), weeklyQuota: q(70, 3 * 86400e3) }, now)
  assert.equal(severity(crit, 20, 10), 'crit')
  assert.equal(worstWindow(crit).key, '5h')
  const pace = serviceModel({ ...base, primaryQuota: q(40, 4.5 * 3600e3), weeklyQuota: q(90, 6 * 86400e3) }, now)
  assert.equal(severity(pace, 20, 10), 'warn')
  const offline = serviceModel({ ...base, status: 'error' }, now)
  assert.equal(severity(offline, 20, 10), '')
})

test('종합 단계는 카드 크기에 따라 정해지고 작은 카드는 작은 형태가 된다', () => {
  assert.equal(richTier(600, 30), 'xs')
  assert.equal(richTier(300, 70), 's')
  assert.equal(richTier(400, 110), 'mw')
  assert.equal(richTier(620, 160), 'lw')
  assert.equal(richTier(280, 260), 'l')
  assert.equal(richTier(120, 220), 'tall')
  assert.equal(formOf('rich', 205, 60), 'compact')
  assert.equal(formOf('battery', 205, 60), 'compact')
  assert.equal(formOf('battery', 300, 200), 'full')
})

test('배치는 창 안에 들어가고, 들어가지 않으면 페이지로 나눈다', () => {
  for (const design of ['rich', 'numeral', 'bars', 'rings', 'timeline', 'battery'] as const) {
    for (const [W, H] of [[628, 472], [288, 172], [628, 62], [968, 512], [248, 592]]) {
      for (let n = 1; n <= 5; n++) {
        const L = chooseLayout(W, H, n, design)
        assert.ok(L.cols * L.rows >= Math.min(n, L.per), `${design} ${W}x${H} n${n}`)
        assert.ok(L.cw * L.cols + 6 * (L.cols - 1) <= W + 1 && L.ch * L.rows + 6 * (L.rows - 1) <= H + 1, `${design} ${W}x${H} n${n} 넘침`)
      }
    }
  }
  // 아주 낮은 창에 다섯 개면 한 페이지에 들어가는 만큼만.
  const flat = chooseLayout(288, 62, 5, 'rich')
  assert.ok(flat.per < 5)
  // 넓고 납작한 창(카드 높이 60)에서는 세 서비스를 가로로 나란히.
  assert.equal(chooseLayout(628, 62, 3, 'rich').cols, 3)
})
