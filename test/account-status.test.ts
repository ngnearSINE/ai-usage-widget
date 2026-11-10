import test from 'node:test'
import assert from 'node:assert/strict'
import type { AccountUsage, QuotaInfo } from '../src/common/types.js'
import { accountGroups, clusterByGroup, nextAccount, pickRecommended } from '../src/common/account-groups.js'
import { cardStatus, resetWhen } from '../src/common/status.js'
import { serviceModel } from '../src/common/usage-model.js'
import { maskText } from '../src/common/privacy.js'

// 리셋 표기는 PC의 현지 시각을 쓰므로 기준도 현지 시각으로 만든다(CI는 UTC).
const NOW = new Date(2026, 10, 10, 12, 0).getTime()
const H = 3600e3
const q = (left: number, resetInMs: number): QuotaInfo => ({ percentLeft: left, percentUsed: 100 - left, remainingFraction: left / 100, resetTime: new Date(NOW + resetInMs).toISOString(), resetCountdown: '' })
const acc = (id: string, provider: string, five: number, week: number, weekReset = 5 * 24 * H, extra: Partial<AccountUsage> = {}): AccountUsage => ({
  id, name: id, provider: provider as AccountUsage['provider'], iconLetter: 'C', brandColor: '#d97757', status: 'ready',
  primaryQuota: q(five, 2 * H), weeklyQuota: q(week, weekReset), updatedAt: new Date(NOW).toISOString(), ...extra,
})

test('추천: 바닥난 계정은 빼고, 가장 빠듯한 한도가 가장 넉넉한 계정', () => {
  const list = [acc('a', 'claude', 0, 80), acc('b', 'claude', 30, 25), acc('c', 'claude', 60, 70)]
  assert.deepEqual(pickRecommended(list, NOW), { id: 'c', reason: 'most' })
})

test('추천: 모두 20% 이상이면 주간 리셋이 하루 안에 오는 계정을 먼저(곧 초기화될 여유)', () => {
  const list = [acc('a', 'claude', 90, 90), acc('b', 'claude', 40, 45, 10 * H), acc('c', 'claude', 50, 30, 20 * H)]
  assert.deepEqual(pickRecommended(list, NOW), { id: 'b', reason: 'soon' })
  // 한 계정이라도 20% 미만이면 그 규칙은 쓰지 않는다
  const tight = [acc('a', 'claude', 90, 90), acc('b', 'claude', 40, 15, 10 * H)]
  assert.deepEqual(pickRecommended(tight, NOW), { id: 'a', reason: 'most' })
})

test('추천: 모두 바닥났거나 값이 없으면 고르지 않는다', () => {
  assert.equal(pickRecommended([acc('a', 'claude', 0, 50), acc('b', 'claude', 40, 0)], NOW), null)
  assert.equal(pickRecommended([acc('a', 'claude', 40, 50, undefined, { status: 'error' })], NOW), null)
})

test('묶음: 계정이 둘 이상인 서비스만, 직접 넣는 카드는 빼고, 같은 서비스를 붙여 놓는다', () => {
  const list = [acc('c1', 'claude', 50, 50), acc('x', 'codex', 50, 50), acc('m', 'custom', 50, 50), acc('c2', 'claude', 80, 80), acc('m2', 'custom', 1, 1)]
  const g = accountGroups(list, NOW)
  assert.deepEqual(g.map(x => [x.provider, x.ids, x.recommended]), [['claude', ['c1', 'c2'], 'c2']])
  assert.deepEqual(clusterByGroup(list).map(u => u.id), ['c1', 'c2', 'x', 'm', 'm2'])
})

test('다음 계정: 바닥난 계정 대신 쓸 같은 서비스 계정과 남은 양', () => {
  const list = [acc('a', 'claude', 0, 70), acc('b', 'claude', 62, 90), acc('x', 'codex', 99, 99)]
  assert.deepEqual(nextAccount(list, 'a', NOW), { id: 'b', name: 'b', left: 62 })
  assert.equal(nextAccount([acc('a', 'claude', 0, 70)], 'a', NOW), null)
})

test('카드 상태: 소진·위험·주의·정상, 갱신 지연, 다시 로그인, 한도 정보 없음, 연결 안 됨', () => {
  const st = (u: AccountUsage) => cardStatus(u, serviceModel(u, NOW), 20, 10).kind
  assert.equal(st(acc('a', 'claude', 0, 50)), 'empty')
  assert.equal(st(acc('a', 'claude', 8, 50)), 'crit')
  assert.equal(st(acc('a', 'claude', 18, 50)), 'warn')
  assert.equal(st(acc('a', 'claude', 80, 70)), 'ok')
  assert.equal(st(acc('a', 'claude', 80, 70, undefined, { status: 'stale' })), 'stale')
  // 마지막 값이 바닥났으면 갱신 지연보다 소진이 앞선다
  assert.equal(st(acc('a', 'claude', 0, 70, undefined, { status: 'stale' })), 'empty')
  assert.equal(st(acc('a', 'claude', 80, 70, undefined, { status: 'unauthenticated', everConnected: true })), 'relogin')
  assert.equal(st(acc('a', 'google', 80, 70, undefined, { status: 'error', everConnected: true, errorMessage: '개인 Google 계정은 볼 수 없음' })), 'noquota')
  assert.equal(st(acc('a', 'claude', 80, 70, undefined, { status: 'error', everConnected: true, errorMessage: 'fetch failed' })), 'error')
  assert.equal(st(acc('a', 'claude', 80, 70, undefined, { status: 'loading' })), 'loading')
  assert.equal(st(acc('a', 'claude', 80, 70, undefined, { status: 'error' })), 'error')
})

test('리셋 표기: 오늘·내일은 단어로, 일주일 안은 요일, 넘으면 날짜, 남은 시간을 함께', () => {
  assert.equal(resetWhen(3 * H, NOW).at, '오늘 15:00')
  assert.equal(resetWhen(21 * H, NOW).at, '내일 09:00')
  assert.match(resetWhen(3 * 24 * H, NOW).at, /^\S+ 12:00$/)
  assert.match(resetWhen(9 * 24 * H, NOW).at, /^11\/19\(\S+\) 12:00$/)
  assert.equal(resetWhen(3 * H, NOW).left, '3시간 0분 후')
  assert.equal(resetWhen(3 * H, NOW).both, '오늘 15:00 · 3시간 0분 후')
})

test('이메일 가리기: 이메일과 자동 이름의 끝 칸만 줄이고, 끄면 그대로', () => {
  assert.equal(maskText('superrogin@gmail.com', true), 's···@g···')
  assert.equal(maskText('Claude 개인 · superrogin', true), 'Claude 개인 · s···')
  assert.equal(maskText('개인 · superrogin@gmail.com', true), '개인 · s···@g···')
  assert.equal(maskText('회사 Claude', true), '회사 Claude')
  assert.equal(maskText('Claude 개인 · superrogin', false), 'Claude 개인 · superrogin')
})

import { pushRecent, rankCommands } from '../src/common/command-match.js'

test('명령 찾기: 낱말 순서와 상관없이 모두 들어 있는 것만, 제목 머리가 먼저, 최근 사용이 앞', () => {
  const list = [
    { id: 'stats', title: '사용량 통계', group: '열기' },
    { id: 'focus-c', title: 'Claude 개인 집중해서 보기', group: '서비스', keywords: 'claude focus' },
    { id: 'cli-c', title: 'Claude 개인 CLI 열기', group: '서비스', keywords: 'claude cli' },
    { id: 'settings', title: '설정', group: '열기' },
  ]
  assert.deepEqual(rankCommands(list, '열기 claude').map(c => c.id), ['cli-c'])
  assert.deepEqual(rankCommands(list, 'cla').map(c => c.id), ['focus-c', 'cli-c'])
  assert.deepEqual(rankCommands(list, '설').map(c => c.id)[0], 'settings')
  assert.deepEqual(rankCommands(list, '', ['settings']).map(c => c.id), ['settings', 'stats', 'focus-c', 'cli-c'])
  assert.deepEqual(rankCommands(list, 'zzz'), [])
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b', 2), ['b', 'a'])
})
