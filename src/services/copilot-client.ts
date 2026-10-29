import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { AccountConfig, AccountUsage } from '../common/types.js'
import { failedUsage, iso, num, quotaFromUsed } from './usage-quota.js'

/**
 * GitHub Copilot 사용량. 편집기 Copilot 플러그인이 저장한 GitHub 토큰(github-copilot/apps.json·hosts.json),
 * 없으면 GitHub CLI 로그인(gh auth token)을 읽기만 하고, Copilot 편집기가 쓰는 copilot_internal/user(공식 문서에 없는 경로)로
 * 이번 달 한도(프리미엄 요청·채팅·자동 완성)를 묻는다. 토큰은 메모리에서만 쓰고 저장·출력하지 않는다.
 */
const USER_URL = 'https://api.github.com/copilot_internal/user'
const TIMEOUT_MS = 8000
const BRAND = { name: 'GitHub Copilot', letter: 'G', color: '#8B949E' }
const GH_TOKEN_TTL_MS = 10 * 60e3

export const COPILOT_TEXT = {
  notLoggedIn: 'GitHub 로그인을 찾지 못했어요. 편집기에서 Copilot에 로그인하거나 터미널에서 gh auth login을 해 주세요',
  expired: 'GitHub 로그인이 만료됐거나 Copilot을 쓸 수 없는 계정이에요. 편집기 Copilot이나 gh auth login으로 다시 로그인해 주세요',
  unavailable: 'Copilot 사용량 정보를 받지 못했어요',
} as const

/** Copilot 편집기 플러그인의 로그인 파일들. */
function pluginTokenFiles() {
  const dirs = [path.join(os.homedir(), '.config', 'github-copilot')]
  if (process.env.LOCALAPPDATA) dirs.unshift(path.join(process.env.LOCALAPPDATA, 'github-copilot'))
  return dirs.flatMap(d => [path.join(d, 'apps.json'), path.join(d, 'hosts.json')])
}

/** 편집기 플러그인이 저장한 github.com 토큰. */
export function readPluginToken(files = pluginTokenFiles()): string | null {
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, { oauth_token?: unknown }>
      for (const [key, v] of Object.entries(raw)) if (key.startsWith('github.com') && typeof v?.oauth_token === 'string' && v.oauth_token) return v.oauth_token
    } catch { /* 없거나 읽지 못함 */ }
  }
  return null
}

/** GitHub CLI 실행 파일. */
export function findGh(): string | null {
  const exe = process.platform === 'win32' ? 'gh.exe' : 'gh'
  const dirs = (process.env.PATH || '').split(path.delimiter)
  if (process.platform === 'win32') dirs.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI'))
  else dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
  for (const d of dirs) { const p = path.join(d, exe); try { if (d && fs.statSync(p).isFile()) return p } catch { /* 없음 */ } }
  return null
}

let ghCache: { at: number; token: string | null } | null = null
/** gh auth token. 조회마다 프로그램을 띄우지 않도록 10분 기억한다(실패도 기억해 반복 실행을 막는다). */
function ghToken(): Promise<string | null> {
  if (ghCache && Date.now() - ghCache.at < GH_TOKEN_TTL_MS) return Promise.resolve(ghCache.token)
  const gh = findGh()
  if (!gh) { ghCache = { at: Date.now(), token: null }; return Promise.resolve(null) }
  return new Promise(resolve => execFile(gh, ['auth', 'token', '--hostname', 'github.com'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
    const token = !err && /^\S+$/.test(stdout.trim()) ? stdout.trim() : null
    ghCache = { at: Date.now(), token }
    resolve(token)
  }))
}

const LABEL: Record<string, string> = { premium_interactions: '프리미엄 요청', chat: '채팅', completions: '자동 완성' }

/** copilot_internal/user 응답을 카드 데이터로. 한도가 있는 것 중 프리미엄 요청 → 채팅 → 자동 완성 순으로 첫 칸에 쓴다. */
export function copilotUsageFromUser(account: AccountConfig, j: any): AccountUsage {
  const snaps = j?.quota_snapshots || {}
  const limited = ['premium_interactions', 'chat', 'completions'].map(k => ({ k, s: snaps[k] })).filter(x => x.s && !x.s.unlimited && (num(x.s.entitlement) ?? 0) > 0)
  const main = limited[0]
  const reset = iso(j?.quota_reset_date_utc) || iso(j?.quota_reset_date)
  const percentUsed = main ? 100 - (num(main.s.percent_remaining) ?? (num(main.s.remaining) ?? 0) / num(main.s.entitlement)! * 100) : 0
  const sku = String(j?.access_type_sku || ''), plan = String(j?.copilot_plan || '')
  const planLabel = /free/i.test(sku) ? 'Free' : plan === 'individual' ? (/pro_plus|plus/i.test(sku) ? 'Pro+' : 'Pro') : plan ? plan.replace(/^\w/, c => c.toUpperCase()) : undefined
  const left = main ? `${LABEL[main.k]} ${Math.max(0, Math.round(num(main.s.remaining) ?? 0))}/${Math.round(num(main.s.entitlement)!)} 남음` : '무제한'
  return {
    id: account.id, name: account.name || BRAND.name, provider: account.provider, iconLetter: BRAND.letter, brandColor: BRAND.color,
    email: typeof j?.login === 'string' ? j.login : undefined, plan: planLabel, tier: `Copilot · ${left}`,
    status: 'ready', primaryKind: 'monthly', primaryQuota: quotaFromUsed(percentUsed, reset), updatedAt: new Date().toISOString(),
  }
}

export class CopilotClient {
  /** Copilot 로그인 흔적(편집기 플러그인 토큰)이 있는지(감지용). gh 로그인만으로는 Copilot을 쓰는지 알 수 없어 보지 않는다. */
  public static hasPluginLogin() { return !!readPluginToken() }

  public static async fetchUsage(account: AccountConfig): Promise<AccountUsage> {
    const token = readPluginToken() || await ghToken()
    if (!token) return failedUsage(account, BRAND, 'unauthenticated', COPILOT_TEXT.notLoggedIn)
    try {
      const res = await fetch(USER_URL, {
        headers: { Authorization: `token ${token}`, Accept: 'application/json', 'Editor-Version': 'vscode/1.96.2', 'Editor-Plugin-Version': 'copilot-chat/0.26.7', 'User-Agent': 'GitHubCopilotChat/0.26.7', 'X-Github-Api-Version': '2025-04-01' },
        signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
      })
      if (res.status === 401 || res.status === 403 || res.status === 404) { await res.body?.cancel().catch(() => {}); ghCache = null; return failedUsage(account, BRAND, 'error', COPILOT_TEXT.expired) }
      if (!res.ok) { await res.body?.cancel().catch(() => {}); return failedUsage(account, BRAND, 'error', `${COPILOT_TEXT.unavailable} (HTTP ${res.status})`) }
      return copilotUsageFromUser(account, await res.json())
    } catch (err: any) {
      return failedUsage(account, BRAND, 'error', err?.name === 'TimeoutError' ? 'Copilot 응답 시간 초과' : err?.message || COPILOT_TEXT.unavailable)
    }
  }
}
