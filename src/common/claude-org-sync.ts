import type { AccountConfig } from './types.js'

export interface ClaudeOrgSeen { orgUuid: string; label: string; fromCli: boolean }

/**
 * 발견된 Claude 조직을 계정 목록에 맞춘다.
 * - 조직 ID가 없는 예전 Claude 카드는 CLI 조직(없으면 아직 카드가 없는 첫 조직)에 한 번 연결하고, 기본 이름이면 새 이름으로 바꾼다.
 *   기록·알림·숨김 설정이 카드 ID에 묶여 있어 새 카드를 만들지 않고 이어 쓴다.
 * - 처음 보는 조직은 카드로 추가한다. 한 번 추가했던 조직(seen)은 지운 뒤 다시 넣지 않는다.
 */
export function syncClaudeOrgAccounts(accounts: AccountConfig[], seenList: string[], orgs: ClaudeOrgSeen[]) {
  const seen = new Set(seenList)
  let next = [...accounts], changed = false
  if (!orgs.length) return { accounts: next, seen: [...seen], changed }
  const free = (o: ClaudeOrgSeen) => !next.some(a => a.orgUuid === o.orgUuid)
  const legacy = next.find(a => a.provider === 'claude' && !a.orgUuid && !a.customMock)
  if (legacy) {
    const target = orgs.find(o => o.fromCli && free(o)) || orgs.find(free)
    if (target) {
      next = next.map(a => a === legacy ? { ...a, orgUuid: target.orgUuid, name: a.name === 'Claude Code' ? target.label : a.name } : a)
      seen.add(target.orgUuid)
      changed = true
    }
  }
  for (const org of orgs) {
    if (!free(org) || seen.has(org.orgUuid)) continue
    next.push({ id: `claude-${org.orgUuid.slice(0, 8)}`, name: org.label, provider: 'claude', enabled: true, orgUuid: org.orgUuid })
    seen.add(org.orgUuid)
    changed = true
  }
  return { accounts: next, seen: [...seen], changed }
}
