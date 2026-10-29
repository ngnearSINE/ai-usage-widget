import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AccountConfig, AccountUsage } from '../common/types.js'
import { failedUsage, iso, jwtPayload, num, quotaFromUsed } from './usage-quota.js'

/**
 * Cursor 사용량. Cursor 앱이 로그인해 둔 토큰(state.vscdb의 cursorAuth/accessToken)을 읽기만 하고,
 * cursor.com 대시보드가 쓰는 /api/usage-summary(공식 문서에 없는 경로)로 이번 결제 주기의 사용률을 묻는다.
 * 토큰은 갱신하지 않는다(Cursor 앱이 갱신한다). 만료되면 Cursor 앱을 열라고 안내한다.
 */
const SUMMARY_URL = 'https://cursor.com/api/usage-summary'
const TIMEOUT_MS = 8000
const BRAND = { name: 'Cursor', letter: 'C', color: '#9CA3AF' }

export const CURSOR_TEXT = {
  notLoggedIn: 'Cursor 앱 로그인을 찾지 못했어요. Cursor 앱에 로그인해 주세요',
  expired: 'Cursor 로그인이 만료됐어요. Cursor 앱을 한 번 열면 다시 연결돼요',
  unavailable: 'Cursor 사용량 정보를 받지 못했어요',
} as const

/** Cursor 앱의 전역 상태 DB 폴더. */
export function cursorStateDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User', 'globalStorage')
}

/**
 * state.vscdb(SQLite)와 쓰기 로그(-wal)에서 cursorAuth/accessToken 바로 뒤의 JWT를 찾는다. 여러 개면 만료가 가장 늦은 것.
 * Electron의 Node에는 SQLite 모듈이 없어 파일을 그대로 훑는다(키와 값이 한 행에 붙어 저장된다). 토큰 값은 밖으로 내보내지 않는다.
 */
export function readCursorToken(dir = cursorStateDir()): { token: string; userId: string; expiresAt: number | null } | null {
  let best: { token: string; userId: string; expiresAt: number | null } | null = null
  for (const name of ['state.vscdb', 'state.vscdb-wal']) {
    let text: string
    try { text = fs.readFileSync(path.join(dir, name)).toString('latin1') } catch { continue }
    for (let i = text.indexOf('cursorAuth/accessToken'); i >= 0; i = text.indexOf('cursorAuth/accessToken', i + 1)) {
      const m = /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(text.slice(i, i + 4000))
      const p = m && jwtPayload(m[0])
      const userId = typeof p?.sub === 'string' ? p.sub.split('|').pop() : ''
      if (!m || !userId) continue
      const expiresAt = typeof p!.exp === 'number' ? p!.exp * 1000 : null
      if (!best || (expiresAt ?? Infinity) > (best.expiresAt ?? Infinity)) best = { token: m[0], userId, expiresAt }
    }
  }
  return best
}

const PLAN: Record<string, string> = { free: 'Free', pro: 'Pro', pro_plus: 'Pro+', ultra: 'Ultra', business: 'Business', enterprise: 'Enterprise', team: 'Team' }

/** usage-summary 응답을 카드 데이터로. 사용률(%)은 그대로 퍼센트 단위이고, 없으면 사용액/한도(센트)로 계산한다. */
export function cursorUsageFromSummary(account: AccountConfig, j: any): AccountUsage {
  const plan = j?.individualUsage?.plan, overall = j?.individualUsage?.overall, pooled = j?.teamUsage?.pooled, onDemand = j?.individualUsage?.onDemand
  const ratio = (o: any) => num(o?.limit) && num(o?.used) !== null ? num(o.used)! / num(o.limit)! * 100 : null
  const auto = num(plan?.autoPercentUsed), api = num(plan?.apiPercentUsed)
  const percent = j?.isUnlimited ? 0
    : num(plan?.totalPercentUsed) ?? (auto !== null && api !== null ? (auto + api) / 2 : api ?? auto) ?? ratio(plan) ?? ratio(overall) ?? ratio(pooled)
  if (percent === null) throw new Error(CURSOR_TEXT.unavailable)
  const extra = onDemand?.enabled && num(onDemand.used) ? ` · 추가 사용 $${(num(onDemand.used)! / 100).toFixed(2)}` : ''
  const kind = String(j?.membershipType || '')
  return {
    id: account.id, name: account.name || BRAND.name, provider: account.provider, iconLetter: BRAND.letter, brandColor: BRAND.color,
    plan: PLAN[kind] || (kind ? kind.replace(/^\w/, c => c.toUpperCase()) : undefined),
    tier: `Cursor${j?.isUnlimited ? ' · 무제한' : ''}${extra}`,
    status: 'ready', primaryKind: 'monthly', primaryQuota: quotaFromUsed(percent, iso(j?.billingCycleEnd)), updatedAt: new Date().toISOString(),
  }
}

export class CursorClient {
  /** Cursor 앱 로그인이 있는지(감지용). */
  public static isLoggedIn() { return !!readCursorToken() }

  public static async fetchUsage(account: AccountConfig): Promise<AccountUsage> {
    const auth = readCursorToken()
    if (!auth) return failedUsage(account, BRAND, 'unauthenticated', CURSOR_TEXT.notLoggedIn)
    if (auth.expiresAt !== null && auth.expiresAt < Date.now() + 60e3) return failedUsage(account, BRAND, 'error', CURSOR_TEXT.expired)
    try {
      const res = await fetch(SUMMARY_URL, {
        headers: { Cookie: `WorkosCursorSessionToken=${auth.userId}%3A%3A${auth.token}`, Accept: 'application/json', Origin: 'https://cursor.com', Referer: 'https://cursor.com/dashboard' },
        signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
      })
      if (res.status === 401 || res.status === 403) { await res.body?.cancel().catch(() => {}); return failedUsage(account, BRAND, 'error', CURSOR_TEXT.expired) }
      if (!res.ok) { await res.body?.cancel().catch(() => {}); return failedUsage(account, BRAND, 'error', `${CURSOR_TEXT.unavailable} (HTTP ${res.status})`) }
      return cursorUsageFromSummary(account, await res.json())
    } catch (err: any) {
      return failedUsage(account, BRAND, 'error', err?.name === 'TimeoutError' ? 'Cursor 응답 시간 초과' : err?.message || CURSOR_TEXT.unavailable)
    }
  }
}
