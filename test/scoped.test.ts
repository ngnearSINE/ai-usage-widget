import test from 'node:test'
import assert from 'node:assert/strict'
import { parseScopedLimits, parseClaudeDesktopLiveUsage } from '../src/services/claude-desktop-oauth.js'
import { serviceModel, windowsOf } from '../src/common/usage-model.js'
import { visibleUsages } from '../src/common/widget-layout.js'
import { previewUsages } from '../src/common/preview-data.js'
import type { AccountConfig, WidgetConfig } from '../src/common/types.js'

// 2026-10-26 팀 조직 실제 응답 모양(값만 바꿈)
const limits = [
  { kind: 'session', group: 'session', percent: 22, resets_at: '2026-10-26T13:10:00+00:00', scope: null },
  { kind: 'weekly_all', group: 'weekly', percent: 46, resets_at: '2026-10-31T07:00:00+00:00', scope: null },
  { kind: 'weekly_scoped', group: 'weekly', percent: 12.4, resets_at: '2026-10-31T07:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
]

test('limits의 모델 전용 주간 한도만 읽고, 형식이 다르면 건너뛴다', () => {
  const s = parseScopedLimits(limits)
  assert.deepEqual(s.map(x => [x.label, x.quota.percentLeft, x.quota.resetTime]), [['Fable', 88, '2026-10-31T07:00:00+00:00']])
  assert.deepEqual(parseScopedLimits([{ kind: 'weekly_scoped', percent: 'x', scope: { model: { display_name: 'A' } } }, { kind: 'weekly_scoped', percent: 1 }]), [])
  assert.deepEqual(parseScopedLimits(undefined), [])
})

test('사용량 응답에 모델 전용 한도가 있으면 카드 데이터에 붙고, 판정용 한도에는 섞이지 않는다', () => {
  const acc: AccountConfig = { id: 'claude-team', name: 'Claude 팀', provider: 'claude', enabled: true }
  const u = parseClaudeDesktopLiveUsage({ five_hour: { utilization: 22, resets_at: '2026-10-26T13:10:00+00:00' }, seven_day: { utilization: 46, resets_at: '2026-10-31T07:00:00+00:00' }, limits }, acc)
  assert.equal(u.scopedQuotas?.[0].label, 'Fable')
  const m = serviceModel(u, Date.parse('2026-10-26T10:00:00Z'))
  assert.deepEqual(windowsOf(m).map(w => w.label), ['5시간', '주간'])
  assert.deepEqual(m.scoped.map(w => [w.label, w.left]), [['Fable', 88]])
  // 없는 조직은 빈 목록
  const p = parseClaudeDesktopLiveUsage({ five_hour: { utilization: 1, resets_at: null }, seven_day: { utilization: 1, resets_at: null } }, acc)
  assert.equal(p.scopedQuotas, undefined)
})

test('작업표시줄에서만 숨긴 계정은 도킹 화면에서만 빠진다', () => {
  const usages = previewUsages().slice(0, 3)
  const accounts: AccountConfig[] = usages.map((u, i) => ({ id: u.id, name: u.name, provider: u.provider, enabled: true, hiddenInDock: i === 1 }))
  const cfg = { hideDisconnected: true } as WidgetConfig
  assert.equal(visibleUsages(usages, accounts, cfg).length, 3)
  assert.deepEqual(visibleUsages(usages, accounts, cfg, true).map(u => u.id), [usages[0].id, usages[2].id])
})
