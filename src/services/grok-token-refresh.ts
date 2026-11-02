import fs from 'node:fs'
import path from 'node:path'
import { isInvalidGrant, RefreshTracker, refreshDecision, writeJsonAtomic, type RefreshResult } from './token-refresh.js'

/**
 * Grok CLI 토큰을 만료된 뒤에만 대신 갱신한다(공통 규칙은 token-refresh).
 * 액세스 토큰은 6시간짜리이고, CLI는 쓰는 동안 저장해 둔 갱신 토큰(refresh_token)으로 조용히 새로 받는다.
 * 위젯은 만료되고 10분이 지나도록 아무도 갱신하지 않았을 때만 CLI와 같은 방식(발급자의 OIDC 설정에 적힌 토큰 주소,
 * 공개 클라이언트 ID, refresh_token 교환)으로 갱신하고, 받은 토큰을 auth.json의 같은 항목에 다시 써 CLI도 이어서 쓰게 한다.
 * 갱신 토큰이 바뀌어 오므로 다시 쓰지 않으면 CLI 로그인이 끊긴다. 그래서 읽은 뒤 파일이 바뀌었으면(그사이 CLI가 갱신) 쓰지 않는다.
 */
const LOCK_FRESH_MS = 60e3

/** auth.json 항목 하나: {"<발급자>::<클라이언트>": { key, refresh_token, expires_at, oidc_issuer, oidc_client_id, ... }} */
export interface GrokAuthEntry { key?: string; refresh_token?: string; expires_at?: string; create_time?: string; oidc_issuer?: string; oidc_client_id?: string; [k: string]: unknown }

const tracker = new RefreshTracker()
const endpoints = new Map<string, string>()

/** 갱신 토큰이 끝나 다시 로그인해야 하는지(마지막 시도 기준). */
export const grokNeedsRelogin = (file: string) => tracker.needsRelogin(path.resolve(file))

/** 갱신할 수 있는 첫 항목. */
export function grokRefreshEntry(raw: Record<string, GrokAuthEntry> | null): [string, GrokAuthEntry] | null {
  for (const [k, v] of Object.entries(raw || {})) if (typeof v?.refresh_token === 'string' && v.refresh_token && typeof v.oidc_issuer === 'string' && typeof v.oidc_client_id === 'string') return [k, v]
  return null
}

/** 받은 토큰으로 항목을 고친다. 다른 필드(이메일·팀 등)는 그대로 둔다. */
export function grokNextEntry(e: GrokAuthEntry, j: { access_token: string; refresh_token?: string; expires_in: number }, now = Date.now()): GrokAuthEntry {
  return { ...e, key: j.access_token, refresh_token: j.refresh_token || e.refresh_token, create_time: new Date(now).toISOString(), expires_at: new Date(now + j.expires_in * 1000).toISOString() }
}

/** 발급자의 토큰 주소(OIDC 설정). 못 읽으면 x.ai가 쓰는 기본 경로. */
async function tokenEndpoint(issuer: string): Promise<string> {
  const base = issuer.replace(/\/+$/, '')
  const known = endpoints.get(base)
  if (known) return known
  let url = `${base}/oauth2/token`
  try {
    const res = await fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000), redirect: 'error' })
    const j = res.ok ? await res.json() as { token_endpoint?: unknown } : null
    if (typeof j?.token_endpoint === 'string' && /^https:\/\//.test(j.token_endpoint)) url = j.token_endpoint
  } catch { /* 기본 경로 */ }
  endpoints.set(base, url)
  return url
}

/** 필요하면 대신 갱신한다. 같은 파일은 여러 곳에서 불러도 한 번만 돈다. */
export function refreshGrokTokenIfExpired(file: string): Promise<RefreshResult> {
  const key = path.resolve(file)
  return tracker.once(key, () => run(key))
}

async function run(file: string): Promise<RefreshResult> {
  let raw: Record<string, GrokAuthEntry>, stat: fs.Stats
  try { stat = fs.statSync(file); raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return 'none' }
  const found = grokRefreshEntry(raw)
  if (!found) return 'none'
  const [name, entry] = found
  const expiresAt = Date.parse(entry.expires_at || '')
  const d = tracker.decided(file, refreshDecision({ refreshToken: entry.refresh_token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined }, Date.now(), tracker.failedAt(file)))
  if (d !== 'refresh') return d
  // CLI가 막 로그인 파일을 다루는 중이면(잠금 파일이 방금 바뀜) 이번엔 건너뛴다.
  try { if (Date.now() - fs.statSync(`${file}.lock`).mtimeMs < LOCK_FRESH_MS) return 'wait' } catch { /* 잠금 파일 없음 */ }
  const res = await fetch(await tokenEndpoint(entry.oidc_issuer!), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000),
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: entry.refresh_token!, client_id: entry.oidc_client_id! }),
  })
  if (res.status !== 200) return tracker.fail(file, isInvalidGrant(res.status, await res.text().catch(() => '')))
  const j = await res.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
  if (typeof j.access_token !== 'string' || typeof j.expires_in !== 'number') return tracker.fail(file)
  // 읽은 뒤 CLI가 파일을 바꿨으면 그쪽 토큰을 살린다(덮어쓰지 않는다).
  const now = fs.statSync(file)
  if (now.mtimeMs !== stat.mtimeMs || now.size !== stat.size) return 'wait'
  writeJsonAtomic(file, { ...raw, [name]: grokNextEntry(entry, { access_token: j.access_token, refresh_token: typeof j.refresh_token === 'string' ? j.refresh_token : undefined, expires_in: j.expires_in }) })
  return tracker.ok(file)
}
