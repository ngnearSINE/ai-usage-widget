import test from 'node:test'
import assert from 'node:assert/strict'
import { staleNotice, staleTip } from '../src/common/stale-notice.js'
import { visibleUsages } from '../src/common/widget-layout.js'
import type { AccountConfig, AccountUsage, WidgetConfig } from '../src/common/types.js'

test('갱신 불가 안내: 흔한 경우를 쉬운 말로', () => {
  assert.match(staleNotice({ provider: 'claude', name: 'Claude', errorMessage: 'Claude Code CLI 토큰이 3시간 전에 만료됐어요. 위젯이 곧 자동으로 다시 연결해요' }).title, /Claude 로그인이 잠시 끊겼어요/)
  assert.match(staleNotice({ provider: 'claude', name: 'Claude', errorMessage: 'Claude Code CLI 로그인 기간(약 한 달)이 끝났어요' }).fix, /다시 로그인/)
  assert.match(staleNotice({ provider: 'xai', name: 'Grok', errorMessage: 'Grok 로그인이 만료됐어요. 터미널에서 grok을 한 번 실행하면 갱신됩니다' }).fix, /grok/)
  assert.match(staleNotice({ provider: 'codex', name: 'Codex', errorMessage: 'fetch failed' }).title, /인터넷/)
  assert.match(staleNotice({ provider: 'claude', name: 'Claude', errorMessage: 'Claude 사용량 API 요청 제한(HTTP 429)' }).title, /잠깐 조회를 막았/)
  assert.match(staleNotice({ provider: 'antigravity', name: 'A', errorMessage: '알 수 없는 오류' }).title, /새로 받지 못했/)
  const tip = staleTip({ provider: 'xai', name: 'Grok', errorMessage: 'Grok 로그인이 만료됐어요', updatedAt: new Date(Date.UTC(2026, 9, 27, 0, 0)).toISOString() }, Date.UTC(2026, 9, 27, 2, 0))
  assert.match(tip, /이유: .*\n이렇게 해 보세요: .*\n지금 보이는 값은 2시간 전/)
})

test('한 번 연결됐던 카드는 연결 안 된 서비스 숨기기를 켜도 보인다', () => {
  const acc = (id: string): AccountConfig => ({ id, name: id, provider: 'claude', enabled: true } as AccountConfig)
  const use = (id: string, status: AccountUsage['status'], everConnected?: boolean) => ({ id, status, everConnected } as AccountUsage)
  const cfg = { hideDisconnected: true } as WidgetConfig
  const shown = visibleUsages([use('a', 'error', true), use('b', 'error'), use('c', 'stale', true), use('d', 'loading')], ['a', 'b', 'c', 'd'].map(acc), cfg).map(u => u.id)
  assert.deepEqual(shown, ['a', 'c'])
})

test('로그인 폴더 Claude 카드는 그 폴더로 다시 로그인하라고 안내한다', () => {
  const n = staleNotice({ provider: 'claude', name: 'Claude 회사', errorMessage: '이 로그인 폴더에서 Claude Code 로그인 정보를 찾지 못했어요. 터미널에서 CLAUDE_CONFIG_DIR을 이 폴더로 두고 claude로 로그인해 주세요' })
  assert.match(n.fix, /CLAUDE_CONFIG_DIR/)
  assert.match(staleNotice({ provider: 'claude', name: 'C', errorMessage: 'Claude Code CLI 로그인 기간(약 한 달)이 끝났어요. 이 로그인 폴더로 다시 로그인해 주세요' }).fix, /CLAUDE_CONFIG_DIR/)
})
