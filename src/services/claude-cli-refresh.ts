import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Claude Code CLI 토큰을 만료된 뒤에만 대신 갱신한다.
 * 액세스 토큰은 8시간짜리이고, CLI는 요청하려는 순간 만료 5분 전이면 스스로 새로 받는다. 위젯은 만료되고 10분이 지나도록
 * 아무도 갱신하지 않았을 때만 CLI와 같은 잠금·주소·형식으로 갱신해 로그인 파일에 다시 쓴다. 그 시점에는 실행 중인 어떤 세션의
 * 액세스 토큰도 이미 만료라서 쓰는 중인 토큰을 빼앗지 않는다(켜 둔 터미널과는 터미널 두 개를 함께 쓸 때와 같은 관계).
 * 갱신 토큰(로그인 후 약 한 달, 갱신해도 늘지 않음)이 끝나면 다시 로그인해야 한다. 토큰 값은 어디에도 남기지 않는다.
 */
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const REFRESH_GRACE_MS = 10 * 60e3
export const RETRY_AFTER_FAIL_MS = 60 * 60e3
const LOCK_STALE_MS = 60e3

export interface CliOauth { accessToken?: string; refreshToken?: string; expiresAt?: number; refreshTokenExpiresAt?: number; scopes?: string[] }
export type RefreshDecision = 'refresh' | 'fresh' | 'wait' | 'relogin' | 'none'

/** 지금 대신 갱신할지(순수 판단). lastFailAt은 마지막 실패 시각. */
export function refreshDecision(o: CliOauth | undefined, now: number, lastFailAt = 0): RefreshDecision {
  if (!o || typeof o.refreshToken !== 'string' || !o.refreshToken || typeof o.expiresAt !== 'number' || o.expiresAt <= 0) return 'none'
  if (typeof o.refreshTokenExpiresAt === 'number' && o.refreshTokenExpiresAt <= now) return 'relogin'
  if (now < o.expiresAt + REFRESH_GRACE_MS) return o.expiresAt > now ? 'fresh' : 'wait'
  if (lastFailAt && now - lastFailAt < RETRY_AFTER_FAIL_MS) return 'wait'
  return 'refresh'
}

export const cliConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

let lastFailAt = 0
let needsRelogin = false
let enabled = false
/** 실제 사용자 데이터로 도는 앱에서만 켠다(미리보기는 다른 앱의 로그인 파일을 건드리지 않는다). */
export function setCliRefreshEnabled(on: boolean) { enabled = on }
let running: Promise<RefreshDecision | 'refreshed' | 'failed'> | null = null

/** 갱신 토큰이 끝나 다시 로그인해야 하는지(마지막 시도 기준). */
export const cliNeedsRelogin = () => needsRelogin

/** CLI 잠금(디렉터리)을 잡는다. 60초 넘은 잠금은 오래된 것으로 보고 치운다. */
function takeLock(lock: string): boolean {
  try { fs.mkdirSync(lock); return true } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_STALE_MS) return false
      fs.rmSync(lock, { recursive: true, force: true }); fs.mkdirSync(lock); return true
    } catch { return false }
  }
}

/** 필요하면 대신 갱신한다. 여러 곳에서 불러도 한 번만 돈다. */
export function refreshCliTokenIfExpired(dir = cliConfigDir()): Promise<RefreshDecision | 'refreshed' | 'failed'> {
  if (!enabled) return Promise.resolve('none')
  running ||= run(dir).finally(() => { running = null })
  return running
}

async function run(dir: string): Promise<RefreshDecision | 'refreshed' | 'failed'> {
  const file = path.join(dir, '.credentials.json'), lock = path.join(dir, '.oauth_refresh.lock')
  let raw: any
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return 'none' }
  const first = refreshDecision(raw?.claudeAiOauth, Date.now(), lastFailAt)
  needsRelogin = first === 'relogin'
  if (first !== 'refresh') return first
  if (!takeLock(lock)) return 'wait' // CLI가 지금 갱신 중
  try {
    // 잠금을 잡은 뒤 다시 읽는다(그사이 CLI가 갱신했을 수 있다).
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const o: CliOauth = raw?.claudeAiOauth
    const again = refreshDecision(o, Date.now(), lastFailAt)
    if (again !== 'refresh') return again
    const res = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: CLIENT_ID, scope: (o.scopes || []).join(' ') }),
    })
    if (res.status !== 200) {
      const body = await res.text().catch(() => '')
      lastFailAt = Date.now()
      // 갱신 토큰이 무효(만료·다른 곳에서 이미 사용)면 다시 로그인해야 한다.
      needsRelogin = res.status === 400 && body.includes('invalid_grant')
      return 'failed'
    }
    const j = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string }
    if (typeof j.access_token !== 'string' || typeof j.expires_in !== 'number') { lastFailAt = Date.now(); return 'failed' }
    const now = Date.now()
    const next = {
      ...raw.claudeAiOauth,
      accessToken: j.access_token,
      refreshToken: j.refresh_token || o.refreshToken,
      expiresAt: now + j.expires_in * 1000,
      ...(typeof j.refresh_token_expires_in === 'number' ? { refreshTokenExpiresAt: now + j.refresh_token_expires_in * 1000 } : {}),
      ...(typeof j.scope === 'string' ? { scopes: j.scope.split(' ').filter(Boolean) } : {}),
    }
    // 다른 항목(MCP 로그인 등)은 그대로 두고 같은 형식으로 원자적으로 쓴다.
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ ...raw, claudeAiOauth: next }), { mode: 0o600 })
    fs.renameSync(tmp, file)
    lastFailAt = 0; needsRelogin = false
    return 'refreshed'
  } catch {
    lastFailAt = Date.now()
    return 'failed'
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}
