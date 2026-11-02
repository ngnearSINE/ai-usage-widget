import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isInvalidGrant, RefreshTracker, refreshDecision, setRefreshEnabled, writeJsonAtomic, type RefreshResult } from './token-refresh.js'

/**
 * Claude Code CLI 토큰을 만료된 뒤에만 대신 갱신한다(공통 규칙은 token-refresh).
 * 액세스 토큰은 8시간짜리이고, CLI는 요청하려는 순간 만료 5분 전이면 스스로 새로 받는다. 위젯은 만료되고 10분이 지나도록
 * 아무도 갱신하지 않았을 때만 CLI와 같은 잠금·주소·형식으로 갱신해 로그인 파일에 다시 쓴다.
 * 갱신 토큰(로그인 후 약 한 달, 갱신해도 늘지 않음)이 끝나면 다시 로그인해야 한다.
 */
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const LOCK_STALE_MS = 60e3

export { refreshDecision, REFRESH_GRACE_MS, RETRY_AFTER_FAIL_MS, type RefreshDecision } from './token-refresh.js'
export interface CliOauth { accessToken?: string; refreshToken?: string; expiresAt?: number; refreshTokenExpiresAt?: number; scopes?: string[] }

export const cliConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

/** 실제 사용자 데이터로 도는 앱에서만 켠다(Claude·Grok 대신 갱신 모두). */
export const setCliRefreshEnabled = setRefreshEnabled

// 로그인 폴더마다 따로 센다(기본 폴더와 '다른 로그인 폴더' 계정).
const tracker = new RefreshTracker()

/** 갱신 토큰이 끝나 다시 로그인해야 하는지(마지막 시도 기준). */
export const cliNeedsRelogin = (dir = cliConfigDir()) => tracker.needsRelogin(path.resolve(dir))

/** CLI 잠금(디렉터리)을 잡는다. 60초 넘은 잠금은 오래된 것으로 보고 치운다. */
function takeLock(lock: string): boolean {
  try { fs.mkdirSync(lock); return true } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_STALE_MS) return false
      fs.rmSync(lock, { recursive: true, force: true }); fs.mkdirSync(lock); return true
    } catch { return false }
  }
}

/** 필요하면 대신 갱신한다. 같은 폴더는 여러 곳에서 불러도 한 번만 돈다. */
export function refreshCliTokenIfExpired(dir = cliConfigDir()): Promise<RefreshResult> {
  const key = path.resolve(dir)
  return tracker.once(key, () => run(key))
}

async function run(dir: string): Promise<RefreshResult> {
  const file = path.join(dir, '.credentials.json'), lock = path.join(dir, '.oauth_refresh.lock')
  let raw: any
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return 'none' }
  const first = tracker.decided(dir, refreshDecision(raw?.claudeAiOauth, Date.now(), tracker.failedAt(dir)))
  if (first !== 'refresh') return first
  if (!takeLock(lock)) return 'wait' // CLI가 지금 갱신 중
  try {
    // 잠금을 잡은 뒤 다시 읽는다(그사이 CLI가 갱신했을 수 있다).
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const o: CliOauth = raw?.claudeAiOauth
    const again = refreshDecision(o, Date.now(), tracker.failedAt(dir))
    if (again !== 'refresh') return again
    const res = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: CLIENT_ID, scope: (o.scopes || []).join(' ') }),
    })
    if (res.status !== 200) return tracker.fail(dir, isInvalidGrant(res.status, await res.text().catch(() => '')))
    const j = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string }
    if (typeof j.access_token !== 'string' || typeof j.expires_in !== 'number') return tracker.fail(dir)
    const now = Date.now()
    const next = {
      ...raw.claudeAiOauth,
      accessToken: j.access_token,
      refreshToken: j.refresh_token || o.refreshToken,
      expiresAt: now + j.expires_in * 1000,
      ...(typeof j.refresh_token_expires_in === 'number' ? { refreshTokenExpiresAt: now + j.refresh_token_expires_in * 1000 } : {}),
      ...(typeof j.scope === 'string' ? { scopes: j.scope.split(' ').filter(Boolean) } : {}),
    }
    // 다른 항목(MCP 로그인 등)은 그대로 둔다.
    writeJsonAtomic(file, { ...raw, claudeAiOauth: next })
    return tracker.ok(dir)
  } catch {
    return tracker.fail(dir)
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}
