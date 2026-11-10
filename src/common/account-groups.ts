import type { AccountUsage } from './types.js'
import { serviceModel, windowsOf, type ServiceModel } from './usage-model.js'

/**
 * 같은 서비스의 여러 계정(예: Claude 개인·팀, Codex 두 로그인 폴더)을 묶고, 그중 '지금 쓰기 좋은 계정'을 고른다.
 *
 * 추천 규칙(여러 구독을 번갈아 쓰는 도구들의 관례):
 * - 한도가 바닥난(어느 한도든 0%) 계정과 값을 모르는 계정은 고르지 않는다.
 * - 고를 수 있는 계정이 모두 넉넉하면(모든 한도 20% 이상) 주간 리셋이 하루 안에 오는 계정을 먼저 쓴다 — 곧 초기화될 여유를 버리지 않게.
 * - 아니면 가장 빠듯한 한도가 가장 넉넉한 계정. 같으면 주간 리셋이 먼저 오는 쪽.
 * 계정을 바꿔 주지는 않는다(안내만 한다).
 */
export const GENEROUS = 20
const DAY = 86400e3

/** 묶음을 만들 서비스인지: 직접 숫자를 넣는 카드는 계정이 아니다. */
const groupable = (u: AccountUsage) => u.provider !== 'custom'

export interface AccountGroup {
  provider: string
  ids: string[]
  /** 지금 쓰기 좋은 계정(없으면 null) */
  recommended: string | null
  /** 추천 이유: 'soon' = 곧 초기화될 여유를 먼저, 'most' = 남은 양이 가장 많음 */
  reason: 'soon' | 'most' | null
}

interface Candidate { id: string; low: number; weeklyReset: number }

const lowest = (m: ServiceModel) => Math.min(...windowsOf(m).map(w => w.left))
const usable = (u: AccountUsage, m: ServiceModel) => m.available && !u.isEstimated && windowsOf(m).length > 0 && lowest(m) > 0

function candidates(list: AccountUsage[], now: number): Candidate[] {
  const out: Candidate[] = []
  for (const u of list) {
    const m = serviceModel(u, now)
    if (!usable(u, m)) continue
    out.push({ id: u.id, low: lowest(m), weeklyReset: m.ww?.resetMs ?? Infinity })
  }
  return out
}

/** 후보 중 지금 쓰기 좋은 계정과 이유. */
export function pickRecommended(list: AccountUsage[], now = Date.now(), exclude?: string): { id: string; reason: 'soon' | 'most' } | null {
  const c = candidates(list, now).filter(x => x.id !== exclude)
  if (!c.length) return null
  if (c.every(x => x.low >= GENEROUS)) {
    const soon = c.filter(x => x.weeklyReset <= DAY).sort((a, b) => a.weeklyReset - b.weeklyReset)[0]
    if (soon) return { id: soon.id, reason: 'soon' }
  }
  const best = [...c].sort((a, b) => b.low - a.low || a.weeklyReset - b.weeklyReset)[0]
  return { id: best.id, reason: 'most' }
}

/** 계정이 둘 이상인 서비스마다 묶음. 순서는 처음 나온 순. */
export function accountGroups(usages: AccountUsage[], now = Date.now()): AccountGroup[] {
  const by = new Map<string, AccountUsage[]>()
  for (const u of usages) if (groupable(u)) by.set(u.provider, [...(by.get(u.provider) || []), u])
  const groups: AccountGroup[] = []
  for (const [provider, list] of by) {
    if (list.length < 2) continue
    const pick = pickRecommended(list, now)
    groups.push({ provider, ids: list.map(u => u.id), recommended: pick?.id ?? null, reason: pick?.reason ?? null })
  }
  return groups
}

/** 같은 서비스 계정이 붙어 있도록 순서를 고친다(각 묶음은 처음 나온 자리로, 묶음 안은 원래 순서). */
export function clusterByGroup<T extends { provider: string }>(list: T[]): T[] {
  const firstAt = new Map<string, number>()
  list.forEach((u, i) => { if (!firstAt.has(u.provider) && u.provider !== 'custom') firstAt.set(u.provider, i) })
  return list.map((u, i) => ({ u, i, k: u.provider === 'custom' ? i : firstAt.get(u.provider)! }))
    .sort((a, b) => a.k - b.k || a.i - b.i).map(x => x.u)
}

/**
 * 바닥난 계정 대신 쓸 수 있는 같은 서비스 계정(남은 양과 함께). 없으면 null.
 * 소진 카드의 안내 행과 알림이 쓴다.
 */
export function nextAccount(usages: AccountUsage[], id: string, now = Date.now()): { id: string; name: string; left: number } | null {
  const me = usages.find(u => u.id === id)
  if (!me || !groupable(me)) return null
  const pick = pickRecommended(usages.filter(u => u.provider === me.provider), now, id)
  if (!pick) return null
  const u = usages.find(x => x.id === pick.id)!
  return { id: u.id, name: u.name, left: lowest(serviceModel(u, now)) }
}
