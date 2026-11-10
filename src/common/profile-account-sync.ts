import type { AccountConfig, ProviderType } from './types.js'

/** 앱 프로필 폴더들에서 찾은 로그인 사용자 하나(같은 사용자가 여러 폴더에 있으면 하나로 묶인 뒤). */
export interface FoundIdentity { key: string; label: string; primary: boolean }

export interface IdentitySyncOptions {
  provider: ProviderType
  /** 카드가 어느 사용자인지 담는 계정 필드 */
  field: 'cursorUser'
  /** 새 카드 ID 앞부분 */
  idPrefix: string
}

/** 카드 ID에 넣을 짧은 표식(사용자 ID 끝부분, 영문·숫자만). */
const shortKey = (key: string) => key.replace(/[^\w]/g, '').slice(-10) || 'x'

/**
 * 찾은 사용자를 계정 목록에 맞춘다.
 * - 이 서비스 카드가 하나도 없으면 아무것도 하지 않는다(서비스를 쓰겠다고 한 적이 없는 사용자에게 카드를 늘리지 않는다).
 * - 사용자가 정해지지 않은 예전 카드는 기본 폴더 사용자(없으면 아직 카드가 없는 첫 사용자)에 한 번 묶는다.
 *   기록·알림·숨김 설정이 카드 ID에 묶여 있어 새 카드를 만들지 않고 이어 쓴다.
 * - 처음 보는 사용자는 카드로 추가한다. 한 번 추가했던 사용자(seen)는 지운 뒤 다시 넣지 않는다.
 */
export function syncIdentityAccounts(accounts: AccountConfig[], seenList: string[], found: FoundIdentity[], o: IdentitySyncOptions) {
  const seen = new Set(seenList)
  let next = [...accounts], changed = false
  const mine = next.filter(a => a.provider === o.provider && !a.customMock && !a.homeDir)
  if (!found.length || !mine.length) return { accounts: next, seen: [...seen], changed }
  const free = (f: FoundIdentity) => !next.some(a => a.provider === o.provider && a[o.field] === f.key)
  const legacy = mine.find(a => !a[o.field])
  if (legacy) {
    const target = found.find(f => f.primary && free(f)) || found.find(free)
    if (target) {
      next = next.map(a => a === legacy ? { ...a, [o.field]: target.key } : a)
      seen.add(target.key)
      changed = true
    }
  }
  // 이미 카드가 있는 사용자도 seen에 넣어 둔다(카드를 지운 뒤 다시 생기지 않게).
  for (const a of next) if (a.provider === o.provider && a[o.field] && !seen.has(a[o.field]!)) { seen.add(a[o.field]!); changed = true }
  for (const f of found) {
    if (!free(f) || seen.has(f.key)) continue
    let id = `${o.idPrefix}-${shortKey(f.key)}`
    while (next.some(a => a.id === id)) id += '_'
    next.push({ id, name: f.label, provider: o.provider, enabled: true, [o.field]: f.key })
    seen.add(f.key)
    changed = true
  }
  return { accounts: next, seen: [...seen], changed }
}
