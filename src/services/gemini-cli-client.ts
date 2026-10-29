import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AccountConfig, AccountUsage } from '../common/types.js'
import { failedUsage, iso, jwtPayload, num, quotaFromUsed } from './usage-quota.js'

/**
 * Gemini CLI 사용량. Gemini CLI가 로그인해 둔 OAuth 토큰(~/.gemini/oauth_creds.json)을 읽고,
 * CLI가 쓰는 Code Assist 경로(공식 문서에 없는 경로)로 오늘의 모델별 남은 비율을 묻는다.
 * 액세스 토큰이 만료됐으면 CLI 설치본에 들어 있는 공개 OAuth 클라이언트 값으로 메모리에서만 새로 받는다(로그인 파일은 다시 쓰지 않는다).
 * Google은 2026-06-18부터 개인·AI Pro·Ultra 계정의 Gemini CLI 사용을 끝냈다. 그런 계정은 Antigravity 카드로 보라고 안내한다.
 */
const API = 'https://cloudcode-pa.googleapis.com/v1internal'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const TIMEOUT_MS = 8000
const BRAND = { name: 'Gemini CLI', letter: 'G', color: '#4E82EE' }

export const GEMINI_TEXT = {
  notLoggedIn: 'Gemini CLI 로그인을 찾지 못했어요. 터미널에서 gemini를 실행해 Google로 로그인해 주세요',
  expired: 'Gemini CLI 로그인이 만료됐어요. 터미널에서 gemini를 한 번 실행하면 다시 연결돼요',
  consumer: '개인 Google 계정(AI Pro·Ultra 포함)은 2026년 6월 18일부터 Gemini CLI 한도를 볼 수 없어요. Antigravity 카드로 확인해 주세요',
  unavailable: 'Gemini 사용량 정보를 받지 못했어요',
} as const

export const geminiCredsPath = () => path.join(os.homedir(), '.gemini', 'oauth_creds.json')

interface Creds { access_token?: string; refresh_token?: string; expiry_date?: number; id_token?: string }

/** Gemini CLI 설치 폴더 후보(npm 전역 설치). */
function cliPackageDirs() {
  const out: string[] = []
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const d of pathDirs) if (fs.existsSync(path.join(d, process.platform === 'win32' ? 'gemini.cmd' : 'gemini'))) out.push(path.join(d, 'node_modules', '@google', 'gemini-cli'), path.join(d, '..', 'lib', 'node_modules', '@google', 'gemini-cli'))
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@google', 'gemini-cli'))
  out.push('/usr/local/lib/node_modules/@google/gemini-cli', '/usr/lib/node_modules/@google/gemini-cli', '/opt/homebrew/lib/node_modules/@google/gemini-cli')
  return [...new Set(out)].filter(d => fs.existsSync(d))
}

let clientCache: { id: string; secret: string } | null | undefined
/** CLI 설치본의 oauth2.js(또는 묶음 파일)에서 OAUTH_CLIENT_ID·SECRET을 찾는다. 환경 변수가 있으면 그 값. */
export function geminiOAuthClient(): { id: string; secret: string } | null {
  if (process.env.GEMINI_OAUTH_CLIENT_ID && process.env.GEMINI_OAUTH_CLIENT_SECRET) return { id: process.env.GEMINI_OAUTH_CLIENT_ID, secret: process.env.GEMINI_OAUTH_CLIENT_SECRET }
  if (clientCache !== undefined) return clientCache
  const pick = (text: string) => {
    const id = /OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1], secret = /OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1]
    return id && secret ? { id, secret } : null
  }
  for (const root of cliPackageDirs()) {
    const known = [path.join(root, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js'), path.join(root, '..', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js')]
    for (const f of known) { try { const r = pick(fs.readFileSync(f, 'utf8')); if (r) return clientCache = r } catch { /* 없음 */ } }
    // 묶음(bundle) 배포: 패키지 안의 js 파일을 얕게 훑는다.
    const stack: Array<[string, number]> = [[root, 0]]
    let seen = 0
    while (stack.length && seen < 400) {
      const [dir, depth] = stack.pop()!
      let entries: fs.Dirent[] = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory() && depth < 5 && !/^(test|tests|docs|\.)/.test(e.name)) stack.push([p, depth + 1])
        else if (e.isFile() && /\.(c|m)?js$/.test(e.name)) {
          seen++
          try { if (fs.statSync(p).size < 30e6) { const r = pick(fs.readFileSync(p, 'utf8')); if (r) return clientCache = r } } catch { /* 건너뜀 */ }
        }
      }
    }
  }
  return clientCache = null
}

let tokenCache: { refresh: string; access: string; until: number } | null = null
/** 쓸 수 있는 액세스 토큰. 만료됐으면 갱신 토큰으로 새로 받는다(메모리에만). */
async function accessToken(c: Creds): Promise<string | null> {
  if (c.access_token && (c.expiry_date ?? 0) > Date.now() + 60e3) return c.access_token
  if (!c.refresh_token) return null
  if (tokenCache?.refresh === c.refresh_token && tokenCache.until > Date.now() + 60e3) return tokenCache.access
  const client = geminiOAuthClient()
  if (!client) return null
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }) })
  if (!res.ok) { await res.body?.cancel().catch(() => {}); return null }
  const j = await res.json() as { access_token?: string; expires_in?: number }
  if (typeof j.access_token !== 'string') return null
  tokenCache = { refresh: c.refresh_token, access: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 }
  return j.access_token
}

/** 모델별 남은 비율 중 Pro(없으면 Flash, 그것도 없으면 전체)에서 가장 적은 것을 첫 칸으로. 리셋은 매일이다. */
export function geminiUsageFromQuota(account: AccountConfig, quota: any, tier: { plan?: string; email?: string }): AccountUsage {
  const buckets = (Array.isArray(quota?.buckets) ? quota.buckets : []).filter((b: any) => num(b?.remainingFraction) !== null)
  if (!buckets.length) throw new Error(GEMINI_TEXT.unavailable)
  const id = (b: any) => String(b.modelId || '').toLowerCase()
  const pro = buckets.filter((b: any) => id(b).includes('pro')), flash = buckets.filter((b: any) => id(b).includes('flash') && !id(b).includes('lite'))
  const group = pro.length ? pro : flash.length ? flash : buckets
  const low = group.reduce((m: any, b: any) => num(b.remainingFraction)! < num(m.remainingFraction)! ? b : m, group[0])
  const family = pro.length ? 'Pro 모델' : flash.length ? 'Flash 모델' : '모델'
  return {
    id: account.id, name: account.name || BRAND.name, provider: account.provider, iconLetter: BRAND.letter, brandColor: BRAND.color,
    email: tier.email, plan: tier.plan, tier: `Gemini CLI · ${family}`,
    status: 'ready', primaryKind: 'daily', primaryQuota: quotaFromUsed((1 - num(low.remainingFraction)!) * 100, iso(low.resetTime)), updatedAt: new Date().toISOString(),
  }
}

/** loadCodeAssist 응답에서 요금제와 '개인 계정 지원 종료' 표시를 읽는다. */
export function geminiTier(j: any): { plan?: string; project?: string; consumerShutdown: boolean } {
  const paid = typeof j?.paidTier?.name === 'string' ? j.paidTier.name : undefined
  const cur = String(j?.currentTier?.id || '')
  const plan = paid || (cur === 'standard-tier' ? 'Standard' : cur === 'free-tier' ? 'Free' : cur === 'legacy-tier' ? 'Legacy' : undefined)
  const unsupported = Array.isArray(j?.ineligibleTiers) && j.ineligibleTiers.some((t: any) => t?.reasonCode === 'UNSUPPORTED_CLIENT')
  const project = typeof j?.cloudaicompanionProject === 'string' ? j.cloudaicompanionProject : typeof j?.cloudaicompanionProject?.id === 'string' ? j.cloudaicompanionProject.id : undefined
  return { plan, project, consumerShutdown: unsupported && !paid && cur !== 'standard-tier' }
}

export class GeminiCliClient {
  public static isLoggedIn() { return fs.existsSync(geminiCredsPath()) }

  public static async fetchUsage(account: AccountConfig): Promise<AccountUsage> {
    let creds: Creds
    try { creds = JSON.parse(fs.readFileSync(geminiCredsPath(), 'utf8')) } catch { return failedUsage(account, BRAND, 'unauthenticated', GEMINI_TEXT.notLoggedIn) }
    try {
      const token = await accessToken(creds)
      if (!token) return failedUsage(account, BRAND, 'error', GEMINI_TEXT.expired)
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const post = (method: string, body: unknown) => fetch(`${API}:${method}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
      const la = await post('loadCodeAssist', { metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } })
      if (la.status === 401) { await la.body?.cancel().catch(() => {}); return failedUsage(account, BRAND, 'error', GEMINI_TEXT.expired) }
      const tier = geminiTier(la.ok ? await la.json() : (await la.body?.cancel().catch(() => {}), null))
      const email = creds.id_token ? jwtPayload(creds.id_token)?.email : undefined
      const q = await post('retrieveUserQuota', tier.project ? { project: tier.project } : {})
      if (q.status === 403 && tier.consumerShutdown) { await q.body?.cancel().catch(() => {}); return failedUsage(account, BRAND, 'error', GEMINI_TEXT.consumer) }
      if (q.status === 401) { await q.body?.cancel().catch(() => {}); return failedUsage(account, BRAND, 'error', GEMINI_TEXT.expired) }
      if (!q.ok) { await q.body?.cancel().catch(() => {}); return failedUsage(account, BRAND, 'error', `${GEMINI_TEXT.unavailable} (HTTP ${q.status})`) }
      return geminiUsageFromQuota(account, await q.json(), { plan: tier.plan, email: typeof email === 'string' ? email : undefined })
    } catch (err: any) {
      return failedUsage(account, BRAND, 'error', err?.name === 'TimeoutError' ? 'Gemini 응답 시간 초과' : err?.message || GEMINI_TEXT.unavailable)
    }
  }
}
