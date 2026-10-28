import test from 'node:test'
import assert from 'node:assert/strict'
import { claudeOrgLabel, claudePlan, groupClaudeOrgs, rateLimitWait, type ClaudeToken } from '../src/services/claude-orgs.js'
import { listClaudeDesktopTokens } from '../src/services/claude-desktop-oauth.js'
import { syncClaudeOrgAccounts } from '../src/common/claude-org-sync.js'
import type { AccountConfig } from '../src/common/types.js'

const team = { orgUuid: 'team-0001-aaaa', orgName: 'acme-labs', orgType: 'claude_team', email: 'jh@example.com' }
const personalSameEmail = { orgUuid: 'pers-0002-bbbb', orgName: "jh@example.com's Organization", orgType: 'claude_pro', email: 'jh@example.com' }
const personalOther = { orgUuid: 'pers-0003-cccc', orgName: "me@gmail.com's Organization", orgType: 'claude_pro', email: 'me@gmail.com' }
const tok = (token: string, source: ClaudeToken['source'], scopes = ['user:profile'], expiresAt = 1000): ClaudeToken => ({ token, source, scopes, expiresAt })

test('팀은 조직 이름, 개인은 이메일 앞부분으로 이름을 붙인다', () => {
  assert.equal(claudeOrgLabel(team).label, 'Claude 팀 · acme-labs')
  assert.equal(claudeOrgLabel(personalSameEmail).label, 'Claude 개인 · jh')
  assert.equal(claudeOrgLabel({ ...team, orgType: 'claude_enterprise' }).kind, '엔터프라이즈')
})

test('같은 이메일의 팀·개인은 조직별로 나뉘고, 같은 조직 토큰은 하나로 묶인다', () => {
  const orgs = groupClaudeOrgs([
    { token: tok('a', 'desktop', ['user:profile'], 5000), profile: team },
    { token: tok('b', 'desktop', ['user:profile', 'user:sessions:claude_code'], 1000), profile: team },
    { token: tok('c', 'desktop'), profile: personalSameEmail },
    { token: tok('d', 'cli'), profile: personalOther },
  ])
  assert.deepEqual(orgs.map(o => o.label), ['Claude 팀 · acme-labs', 'Claude 개인 · jh', 'Claude 개인 · me'])
  // Claude Code 범위가 있는 토큰을 먼저 쓴다.
  assert.deepEqual(orgs[0].tokens.map(t => t.token), ['b', 'a'])
})

test('데스크톱 캐시에서 anthropic 토큰 중 유효하고 profile 범위가 있는 것만 고른다', () => {
  const now = 1000
  const cache = {
    'acct:u1|client:https://api.anthropic.com:user:inference user:profile': { token: 't1', expiresAt: 5000 },
    'acct:u1|client:https://api.anthropic.com:user:inference': { token: 't2', expiresAt: 5000 },
    'acct:u2|client:https://api.anthropic.com:user:profile': { token: 't3', expiresAt: 500 },
    'acct:u3|client:https://dev.example.com:user:profile': { token: 't4', expiresAt: 5000 },
  }
  assert.deepEqual(listClaudeDesktopTokens(cache, now).map(t => t.token), ['t1'])
})

test('예전 Claude 카드는 CLI 조직에 이어 붙이고, 새 조직은 추가하되 지운 조직은 다시 넣지 않는다', () => {
  const accounts: AccountConfig[] = [{ id: 'local-claude-code', name: 'Claude Code', provider: 'claude', enabled: true }, { id: 'local-codex', name: 'Codex', provider: 'codex', enabled: true }]
  const orgs = [
    { orgUuid: team.orgUuid, label: 'Claude 팀 · acme-labs', fromCli: false },
    { orgUuid: personalOther.orgUuid, label: 'Claude 개인 · me', fromCli: true },
  ]
  const r = syncClaudeOrgAccounts(accounts, [], orgs)
  assert.equal(r.changed, true)
  assert.deepEqual(r.accounts.map(a => [a.id, a.name, a.orgUuid]), [
    ['local-claude-code', 'Claude 개인 · me', personalOther.orgUuid],
    ['local-codex', 'Codex', undefined],
    ['claude-team-000', 'Claude 팀 · acme-labs', team.orgUuid],
  ])
  // 다시 맞춰도 바뀌지 않는다.
  assert.equal(syncClaudeOrgAccounts(r.accounts, r.seen, orgs).changed, false)
  // 팀 카드를 지운 뒤에는 다시 넣지 않는다.
  const removed = r.accounts.filter(a => a.orgUuid !== team.orgUuid)
  assert.equal(syncClaudeOrgAccounts(removed, r.seen, orgs).changed, false)
  // 사용자가 바꾼 이름은 그대로 둔다.
  const renamed = syncClaudeOrgAccounts([{ ...accounts[0], name: '내 Claude' }], [], orgs)
  assert.equal(renamed.accounts[0].name, '내 Claude')
})

test('CLI 토큰이 만료돼 조직을 모르면 예전 카드를 묶지 않고 미룬다', async () => {
  const { syncClaudeOrgAccounts } = await import('../src/common/claude-org-sync.js')
  const acc = [{ id: 'claude-code', name: 'Claude Code', provider: 'claude' as const, enabled: true }]
  const orgs = [{ orgUuid: 'team-1', label: 'Claude 팀', fromCli: false }, { orgUuid: 'me-1', label: 'Claude 개인', fromCli: false }]
  assert.equal(syncClaudeOrgAccounts(acc, [], orgs, true).changed, false)
  assert.equal(syncClaudeOrgAccounts(acc, [], orgs, false).accounts[0].orgUuid, 'team-1', '만료가 아니면 전처럼 묶는다')
})

test('플랜 배지: 조직 종류와 사용량 등급', () => {
  assert.equal(claudePlan('claude_team', 'default_claude_max_5x'), 'Team 5x')
  assert.equal(claudePlan('claude_team'), 'Team')
  assert.equal(claudePlan('claude_max', 'default_claude_max_20x'), 'Max 20x')
  assert.equal(claudePlan('', 'default_claude_max_5x'), 'Max 5x')
  assert.equal(claudePlan('claude_pro'), 'Pro')
  assert.equal(claudePlan('claude_enterprise'), 'Enterprise')
  assert.equal(claudePlan(''), '')
})

test('요청 제한(429)을 연달아 받을수록 오래 쉬되 10분을 넘지 않고, 서비스가 알려 준 시간보다 짧게 쉬지 않는다', () => {
  const min = 60e3
  assert.equal(rateLimitWait(30e3, 1), 4 * min)
  assert.equal(rateLimitWait(30e3, 2), 8 * min)
  assert.equal(rateLimitWait(30e3, 5), 10 * min)
  assert.equal(rateLimitWait(15 * min, 1), 15 * min)
})

test('로그인 폴더로 추가한 Claude 카드는 예전 카드로 보고 조직에 묶지 않는다', () => {
  const home: AccountConfig = { id: 'claude-home-1', name: 'Claude 회사', provider: 'claude', enabled: true, homeDir: 'C:\claude-work' }
  const r = syncClaudeOrgAccounts([home], [], [{ orgUuid: 'team-1', label: 'Claude 팀 · A', fromCli: true }])
  assert.equal(r.accounts.find(a => a.id === home.id)?.orgUuid, undefined)
  assert.equal(r.accounts.length, 2, '찾은 조직은 따로 카드가 된다')
})
