import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AccountConfig, AccountUsage } from '../common/types.js'
import { failedUsage, iso, jwtPayload, num, quotaFromUsed } from './usage-quota.js'
import { msg } from '../common/i18n.js'
import { AppProfiles } from './app-profiles.js'

/**
 * Cursor 사용량. Cursor 앱이 로그인해 둔 토큰(state.vscdb의 cursorAuth/accessToken)을 읽기만 하고,
 * cursor.com 대시보드가 쓰는 /api/usage-summary(공식 문서에 없는 경로)로 이번 결제 주기의 사용률을 묻는다.
 * 토큰은 갱신하지 않는다(Cursor 앱이 갱신한다). 만료되면 Cursor 앱을 열라고 안내한다.
 */
const SUMMARY_URL = 'https://cursor.com/api/usage-summary'
const TIMEOUT_MS = 8000
const BRAND = { name: 'Cursor', letter: 'C', color: '#9CA3AF' }

export const CURSOR_TEXT = {
  notLoggedIn: msg('Cursor 앱 로그인을 찾지 못했어요. Cursor 앱에 로그인해 주세요'),
  expired: msg('Cursor 로그인이 만료됐어요. Cursor 앱을 한 번 열면 다시 연결돼요'),
  unavailable: msg('Cursor 사용량 정보를 받지 못했어요'),
  profileMissing: msg('이 Cursor 계정이 로그인한 프로필 폴더를 찾지 못했어요. 그 프로필로 Cursor를 한 번 열어 주세요'),
} as const

/** Cursor 앱의 전역 상태 DB 폴더. */
export function cursorStateDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User', 'globalStorage')
}

export interface CursorAuth { token: string; userId: string; expiresAt: number | null; email?: string }

/**
 * state.vscdb(SQLite)와 쓰기 로그(-wal)에서 cursorAuth/accessToken 바로 뒤의 JWT를 찾는다. 여러 개면 만료가 가장 늦은 것.
 * Electron의 Node에는 SQLite 모듈이 없어 파일을 그대로 훑는다(키와 값이 한 행에 붙어 저장된다). 토큰 값은 밖으로 내보내지 않는다.
 * 로그인 이메일(cursorAuth/cachedEmail)도 같이 읽는다. 상태 DB가 수백 MB일 수 있어 파일이 바뀌지 않았으면 지난 결과를 쓴다.
 */
const authMemo = new Map<string, { key: string; value: CursorAuth | null }>()
export function readCursorToken(dir = cursorStateDir()): CursorAuth | null {
  const files = ['state.vscdb', 'state.vscdb-wal'].map(n => path.join(dir, n))
  const key = files.map(f => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}` } catch { return '-' } }).join('|')
  const hit = authMemo.get(dir)
  if (hit && hit.key === key) return hit.value
  let best: CursorAuth | null = null, email: string | undefined
  for (const file of files) {
    let text: string
    try { text = fs.readFileSync(file).toString('latin1') } catch { continue }
    for (let i = text.indexOf('cursorAuth/accessToken'); i >= 0; i = text.indexOf('cursorAuth/accessToken', i + 1)) {
      const m = /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(text.slice(i, i + 4000))
      const p = m && jwtPayload(m[0])
      const userId = typeof p?.sub === 'string' ? p.sub.split('|').pop() : ''
      if (!m || !userId) continue
      const expiresAt = typeof p!.exp === 'number' ? p!.exp * 1000 : null
      if (!best || (expiresAt ?? Infinity) > (best.expiresAt ?? Infinity)) best = { token: m[0], userId, expiresAt }
    }
    // 키는 색인 쪽에도 값 없이 나오므로 바로 뒤에 이메일이 붙은 자리만 쓴다(쓰기 로그 쪽이 더 새 값).
    for (let e = text.indexOf('cursorAuth/cachedEmail'); e >= 0; e = text.indexOf('cursorAuth/cachedEmail', e + 1)) {
      const found = /^[\x00-\x20]{0,8}([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/.exec(text.slice(e + 'cursorAuth/cachedEmail'.length, e + 200))
      if (found) { email = found[1]; break }
    }
  }
  const value = best ? { ...best, ...(email ? { email } : {}) } : null
  authMemo.set(dir, { key, value })
  return value
}

/** 찾은 Cursor 프로필 폴더마다 로그인한 사용자. 같은 사용자가 여러 프로필에 있으면 하나로 묶는다. */
export interface CursorUser { userId: string; email?: string; auth: CursorAuth; dirs: string[]; primary: boolean }
export function cursorUsers(): CursorUser[] {
  const def = path.resolve(path.dirname(path.dirname(cursorStateDir())))
  const byUser = new Map<string, CursorUser>()
  for (const dir of AppProfiles.dirs('cursor')) {
    const auth = readCursorToken(path.join(dir, 'User', 'globalStorage'))
    if (!auth) continue
    const u = byUser.get(auth.userId) || { userId: auth.userId, email: auth.email, auth, dirs: [], primary: false }
    u.dirs.push(dir)
    if (path.resolve(dir).toLowerCase() === def.toLowerCase()) u.primary = true
    if ((auth.expiresAt ?? Infinity) > (u.auth.expiresAt ?? Infinity)) u.auth = auth
    u.email ||= auth.email
    byUser.set(auth.userId, u)
  }
  return [...byUser.values()]
}

/** 카드 기본 이름: 'Cursor · 이메일 앞부분'(이메일을 모르면 프로필 폴더 이름). */
export const cursorUserLabel = (u: Pick<CursorUser, 'email' | 'dirs'>) => `Cursor · ${u.email?.split('@')[0] || path.basename(u.dirs[0] || '') || '?'}`

const PLAN: Record<string, string> = { free: 'Free', pro: 'Pro', pro_plus: 'Pro+', ultra: 'Ultra', business: 'Business', enterprise: 'Enterprise', team: 'Team' }

/** usage-summary 응답을 카드 데이터로. 사용률(%)은 그대로 퍼센트 단위이고, 없으면 사용액/한도(센트)로 계산한다. */
export function cursorUsageFromSummary(account: AccountConfig, j: any): AccountUsage {
  const plan = j?.individualUsage?.plan, overall = j?.individualUsage?.overall, pooled = j?.teamUsage?.pooled, onDemand = j?.individualUsage?.onDemand
  const ratio = (o: any) => num(o?.limit) && num(o?.used) !== null ? num(o.used)! / num(o.limit)! * 100 : null
  const auto = num(plan?.autoPercentUsed), api = num(plan?.apiPercentUsed)
  const percent = j?.isUnlimited ? 0
    : num(plan?.totalPercentUsed) ?? (auto !== null && api !== null ? (auto + api) / 2 : api ?? auto) ?? ratio(plan) ?? ratio(overall) ?? ratio(pooled)
  if (percent === null) throw new Error(CURSOR_TEXT.unavailable)
  const extra = onDemand?.enabled && num(onDemand.used) ? (num(onDemand.used)! / 100).toFixed(2) : ''
  const kind = String(j?.membershipType || '')
  return {
    id: account.id, name: account.name || BRAND.name, provider: account.provider, iconLetter: BRAND.letter, brandColor: BRAND.color,
    plan: PLAN[kind] || (kind ? kind.replace(/^\w/, c => c.toUpperCase()) : undefined),
    tier: extra ? (j?.isUnlimited ? msg('Cursor · 무제한 · 추가 사용 ${amount}', { amount: extra }) : msg('Cursor · 추가 사용 ${amount}', { amount: extra })) : j?.isUnlimited ? msg('Cursor · 무제한') : 'Cursor',
    status: 'ready', primaryKind: 'monthly', primaryQuota: quotaFromUsed(percent, iso(j?.billingCycleEnd)), updatedAt: new Date().toISOString(),
  }
}

export class CursorClient {
  /** Cursor 앱 로그인이 있는지(감지용, 다른 프로필 폴더 포함). */
  public static isLoggedIn() { return cursorUsers().length > 0 }

  /** 이 카드가 쓸 로그인: 사용자 ID가 정해진 카드는 그 사용자, 예전 카드는 기본 폴더(없으면 처음 찾은 사용자). */
  private static authFor(account: AccountConfig): CursorUser | null {
    const users = cursorUsers()
    if (account.cursorUser) return users.find(u => u.userId === account.cursorUser) || null
    return users.find(u => u.primary) || users[0] || null
  }

  public static async fetchUsage(account: AccountConfig): Promise<AccountUsage> {
    const user = this.authFor(account), auth = user?.auth
    if (!auth) return failedUsage(account, BRAND, 'unauthenticated', account.cursorUser ? CURSOR_TEXT.profileMissing : CURSOR_TEXT.notLoggedIn)
    if (auth.expiresAt !== null && auth.expiresAt < Date.now() + 60e3) return failedUsage(account, BRAND, 'error', CURSOR_TEXT.expired)
    try {
      const res = await fetch(SUMMARY_URL, {
        headers: { Cookie: `WorkosCursorSessionToken=${auth.userId}%3A%3A${auth.token}`, Accept: 'application/json', Origin: 'https://cursor.com', Referer: 'https://cursor.com/dashboard' },
        signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
      })
      if (res.status === 401 || res.status === 403) { await res.body?.cancel().catch(() => {}); return failedUsage(account, BRAND, 'error', CURSOR_TEXT.expired) }
      if (!res.ok) { await res.body?.cancel().catch(() => {}); return failedUsage(account, BRAND, 'error', `${CURSOR_TEXT.unavailable} (HTTP ${res.status})`) }
      const usage = cursorUsageFromSummary(account, await res.json())
      return user?.email ? { ...usage, email: user.email } : usage
    } catch (err: any) {
      return failedUsage(account, BRAND, 'error', err?.name === 'TimeoutError' ? msg('Cursor 응답 시간 초과') : err?.message || CURSOR_TEXT.unavailable)
    }
  }
}
