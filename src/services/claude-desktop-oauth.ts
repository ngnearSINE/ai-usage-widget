import fs from 'node:fs'
import path from 'node:path'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { spawn } from 'node:child_process'
import { formatCountdown } from '../common/time-utils.js'
import type { AccountConfig, AccountUsage, QuotaInfo } from '../common/types.js'
import { appDataDir } from './platform-paths.js'

export function findClaudeDataDirs(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  // Linux: ~/.config/Claude
  if (platform !== 'win32') return [path.join(appDataDir(env, platform), 'Claude')]
  const dirs: string[] = []
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'Claude'))
  if (env.LOCALAPPDATA) {
    const packages = path.join(env.LOCALAPPDATA, 'Packages')
    try {
      for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
        if (entry.isDirectory() && (/^Claude_/i.test(entry.name) || (/Claude/i.test(entry.name) && /Anthropic/i.test(entry.name)))) {
          dirs.push(path.join(packages, entry.name, 'LocalCache', 'Roaming', 'Claude'))
        }
      }
    } catch { /* Store installation is optional. */ }
  }
  return [...new Set(dirs)]
}

// Only the DPAPI-wrapped encryption key crosses stdin. No credentials in argv,
// temporary files, stderr, or application logs. Windows PowerShell ships with Windows.
function unprotectKey(wrapped: Buffer): Promise<Buffer> {
  const script = `$ErrorActionPreference='Stop'; try {
    Add-Type -AssemblyName System.Security
    $wrapped=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
    $key=[Security.Cryptography.ProtectedData]::Unprotect($wrapped,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($key))
    [Array]::Clear($key,0,$key.Length)
  } catch { exit 1 }`
  const executable = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 5000, stdio: ['pipe', 'pipe', 'ignore']
    })
    let output = ''
    let settled = false
    const fail = () => {
      if (!settled) {
        settled = true
        reject(new Error('Claude 앱 암호화 키 복호화 실패'))
      }
    }
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      if (output.length > 1024) { child.kill(); fail() }
    })
    child.on('close', code => {
      if (settled) return
      const key = Buffer.from(output.trim(), 'base64')
      output = ''
      if (code === 0 && key.length === 32) {
        settled = true
        resolve(key)
      } else {
        key.fill(0)
        fail()
      }
    })
    child.stdin.end(wrapped.toString('base64'))
  })
}

/**
 * Linux의 Electron safeStorage 암호: GNOME 키링(Secret Service)의 'chrome_libsecret_os_crypt_password_v2'
 * 항목(application=Claude). python3의 GObject(libsecret) 또는 dbus로 읽는다. 둘 다 Ubuntu 데스크톱 기본 설치다.
 * 값은 stdout으로만 받고 인자·파일·로그에 남기지 않는다.
 */
const LINUX_SECRET_SCRIPT = [
  'import sys, base64',
  'app = sys.argv[1]',
  'def via_gi():',
  "    import gi; gi.require_version('Secret', '1'); from gi.repository import Secret",
  "    schema = Secret.Schema.new('chrome_libsecret_os_crypt_password_v2', Secret.SchemaFlags.DONT_MATCH_NAME, {'application': Secret.SchemaAttributeType.STRING})",
  "    return Secret.password_lookup_sync(schema, {'application': app}, None)",
  'def via_dbus():',
  '    import dbus',
  "    bus = dbus.SessionBus(); svc = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets')",
  "    iface = dbus.Interface(svc, 'org.freedesktop.Secret.Service')",
  "    _, session = iface.OpenSession('plain', dbus.String('', variant_level=1))",
  "    unlocked, locked = iface.SearchItems({'xdg:schema': 'chrome_libsecret_os_crypt_password_v2', 'application': app})",
  '    items = list(unlocked)',
  '    if not items: return None',
  "    item = dbus.Interface(bus.get_object('org.freedesktop.secrets', items[0]), 'org.freedesktop.Secret.Item')",
  "    return bytes(item.GetSecret(session)[2]).decode('utf8')",
  'pw = None',
  'for f in (via_gi, via_dbus):',
  '    try:',
  '        pw = f()',
  '        if pw: break',
  '    except Exception: pass',
  'if not pw: sys.exit(1)',
  "sys.stdout.write(base64.b64encode(pw.encode('utf8')).decode())",
].join('\n')
function linuxSafeStoragePassword(app = 'Claude'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    if (!env.DBUS_SESSION_BUS_ADDRESS && typeof process.getuid === 'function') env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${process.getuid()}/bus`
    const child = spawn('python3', ['-c', LINUX_SECRET_SCRIPT, app], { env, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.on('error', () => reject(new Error('키링 암호 읽기 실패')))
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 4096) child.kill() })
    child.on('close', code => {
      const pw = Buffer.from(output.trim(), 'base64'); output = ''
      if (code === 0 && pw.length) resolve(pw); else { pw.fill(0); reject(new Error('키링 암호 읽기 실패')) }
    })
  })
}

/** Linux Chromium os_crypt: v11은 키링 암호, v10은 고정 암호 'peanuts'. PBKDF2(1회, saltysalt)로 만든 AES-128-CBC, IV는 공백 16개. */
export function decryptClaudeCacheLinux(encoded: string, password: Buffer): unknown {
  const blob = Buffer.from(encoded, 'base64')
  if (blob.length < 19 || !['v10', 'v11'].includes(blob.subarray(0, 3).toString())) throw new Error('지원하지 않는 Claude 앱 OAuth 암호화 형식')
  const key = pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1')
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const partial = decipher.update(blob.subarray(3))
  let plain: Buffer | undefined
  try {
    plain = Buffer.concat([partial, decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  } finally { partial.fill(0); plain?.fill(0); key.fill(0) }
}

/** 실패 단계(복호화 내용이 섞이지 않게 단계 이름만). bare면 '실패'를 붙이지 않는다. */
class StepError extends Error { constructor(readonly step: string, readonly bare = false) { super(step) } }

/** 이 폴더의 OAuth 캐시를 연다(Windows DPAPI 키, Linux 키링 암호). */
async function openClaudeCache(dir: string, encoded: string): Promise<unknown> {
  if (process.platform !== 'win32') {
    const v10 = Buffer.from(encoded, 'base64').subarray(0, 3).toString() === 'v10'
    let password: Buffer
    try { password = v10 ? Buffer.from('peanuts') : await linuxSafeStoragePassword() } catch { throw new StepError('키링 암호 읽기') }
    try { return decryptClaudeCacheLinux(encoded, password) } catch { throw new StepError('OAuth 캐시 복호화') } finally { password.fill(0) }
  }
  let state: any
  try { state = JSON.parse(await fs.promises.readFile(path.join(dir, 'Local State'), 'utf8')) } catch { throw new StepError('Local State 읽기') }
  if (typeof state.os_crypt?.encrypted_key !== 'string') throw new StepError('encrypted_key 없음', true)
  const wrapped = Buffer.from(state.os_crypt.encrypted_key, 'base64')
  if (wrapped.subarray(0, 5).toString() !== 'DPAPI') throw new StepError('DPAPI 접두사 없음', true)
  let key: Buffer
  try { key = await unprotectKey(wrapped.subarray(5)) } catch { throw new StepError('DPAPI 키 복호화') }
  try { return decryptClaudeCache(encoded, key) } catch { throw new StepError('OAuth 캐시 복호화') } finally { key.fill(0) }
}

/** 데스크톱 앱 로그인 흔적: config.json(+ Windows는 Local State의 암호화 키). */
export function hasDesktopSession(dir: string, platform = process.platform) {
  return fs.existsSync(path.join(dir, 'config.json')) && (platform !== 'win32' || fs.existsSync(path.join(dir, 'Local State')))
}

export function decryptClaudeCache(encoded: string, key: Buffer): unknown {
  const blob = Buffer.from(encoded, 'base64')
  if (blob.length < 31 || !['v10', 'v11'].includes(blob.subarray(0, 3).toString())) {
    throw new Error('지원하지 않는 Claude 앱 OAuth 암호화 형식')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(3, 15))
  decipher.setAuthTag(blob.subarray(-16))
  const partial = decipher.update(blob.subarray(15, -16))
  let plain: Buffer | undefined
  try {
    plain = Buffer.concat([partial, decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  } finally { partial.fill(0); plain?.fill(0) }
}

interface DesktopToken { token: string; expiresAt: number; subscriptionType?: string }

export function selectClaudeDesktopToken(cache: unknown, activeAccount: unknown, now = Date.now()): DesktopToken {
  if (!cache || typeof cache !== 'object' || typeof activeAccount !== 'string' || !activeAccount) {
    throw new Error('Claude 앱 활성 계정 또는 OAuth 캐시 없음')
  }
  const candidates: DesktopToken[] = []
  for (const [key, raw] of Object.entries(cache)) {
    const match = /^acct:([^|]+)\|(.+)$/.exec(key)
    if (!match || match[1].toLowerCase() !== activeAccount.toLowerCase()) continue
    // Do not send tokens from overridden development hosts or unrelated scopes.
    const hostIdx = match[2].indexOf(':https://api.anthropic.com:')
    if (hostIdx === -1) continue
    const scopes = match[2].substring(hostIdx + ':https://api.anthropic.com:'.length).split(' ')
    if (!scopes.includes('user:sessions:claude_code')) continue
    const entry = raw as Partial<DesktopToken> | null
    if (!entry || typeof entry.token !== 'string' || !entry.token ||
        typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) continue
    candidates.push(entry as DesktopToken)
  }
  candidates.sort((a, b) => b.expiresAt - a.expiresAt)
  if (!candidates.length) throw new Error('Claude 앱 사용량 조회 세션 없음 또는 만료됨')
  return candidates[0]
}

export function parseClaudeDesktopLiveUsage(raw: unknown, account: AccountConfig, tier?: string): AccountUsage {
  function quota(value: unknown): QuotaInfo {
    const v = value as { utilization?: unknown; resets_at?: unknown } | null
    if (!v || typeof v.utilization !== 'number' || !Number.isFinite(v.utilization) ||
        v.utilization < 0 || v.utilization > 100 ||
        (v.resets_at != null && (typeof v.resets_at !== 'string' || !Number.isFinite(Date.parse(v.resets_at))))) {
      throw new Error('Claude 앱 사용량 응답 형식 오류')
    }
    const used = Math.round(v.utilization)
    const resetTime = typeof v.resets_at === 'string' ? v.resets_at : undefined
    return { percentUsed: used, percentLeft: 100 - used, remainingFraction: (100 - used) / 100,
      resetTime, resetCountdown: formatCountdown(resetTime), isExhausted: v.utilization >= 100 }
  }
  const data = raw as { five_hour?: unknown; seven_day?: unknown; limits?: unknown } | null
  if (!data) throw new Error('Claude 앱 사용량 응답 없음')
  const scopedQuotas = parseScopedLimits(data.limits)
  return {
    id: account.id, name: account.name || 'Claude Code', provider: 'claude', iconLetter: 'C',
    brandColor: '#D97757', tier: `${tier?.toUpperCase() || 'Claude'} (앱 실시간 세션)`,
    dataSource: 'claude-desktop-live', status: 'ready', primaryQuota: quota(data.five_hour),
    weeklyQuota: data.seven_day == null ? undefined : quota(data.seven_day), updatedAt: new Date().toISOString(),
    ...(scopedQuotas.length ? { scopedQuotas } : {})
  }
}

/** 데스크톱 앱 OAuth 캐시의 anthropic 토큰 중 아직 유효한 것을 모두 돌려준다(계정·조직 구분은 호출한 쪽이 profile로 한다). */
export interface ClaudeDesktopTokenEntry { accountUuid: string; token: string; expiresAt: number; scopes: string[] }
export function listClaudeDesktopTokens(cache: unknown, now = Date.now()): ClaudeDesktopTokenEntry[] {
  if (!cache || typeof cache !== 'object') return []
  const out: ClaudeDesktopTokenEntry[] = []
  for (const [key, raw] of Object.entries(cache)) {
    const match = /^acct:([^|]+)\|(.+)$/.exec(key)
    if (!match) continue
    const hostIdx = match[2].indexOf(':https://api.anthropic.com:')
    if (hostIdx === -1) continue
    const scopes = match[2].substring(hostIdx + ':https://api.anthropic.com:'.length).split(' ')
    if (!scopes.includes('user:profile')) continue
    const entry = raw as Partial<DesktopToken> | null
    if (!entry || typeof entry.token !== 'string' || !entry.token ||
        typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) continue
    out.push({ accountUuid: match[1], token: entry.token, expiresAt: entry.expiresAt, scopes })
  }
  return out
}

export async function readClaudeDesktopTokens(): Promise<ClaudeDesktopTokenEntry[]> {
  if (process.platform !== 'win32' && process.platform !== 'linux') return []
  const out: ClaudeDesktopTokenEntry[] = []
  for (const dir of findClaudeDataDirs()) {
    try {
      if (!hasDesktopSession(dir)) continue
      const config = JSON.parse(await fs.promises.readFile(path.join(dir, 'config.json'), 'utf8'))
      if (typeof config['oauth:tokenCacheV2'] !== 'string') continue
      out.push(...listClaudeDesktopTokens(await openClaudeCache(dir, config['oauth:tokenCacheV2'])))
    } catch { /* 이 폴더는 건너뛴다. 예외 메시지에 복호화 내용이 섞일 수 있어 남기지 않는다 */ }
  }
  return out
}

/**
 * limits 중 모델 전용 주간 한도. 예(2026-10-26, 팀 조직): {kind:'weekly_scoped', percent:0, resets_at, scope:{model:{display_name:'Fable'}}}.
 * percent는 그 모델 몫 안에서 쓴 비율이다. 형식이 다르면 조용히 건너뛴다(본 한도 표시를 막지 않는다).
 */
export function parseScopedLimits(limits: unknown): Array<{ label: string; quota: QuotaInfo }> {
  if (!Array.isArray(limits)) return []
  const out: Array<{ label: string; quota: QuotaInfo }> = []
  for (const l of limits as Array<Record<string, any>>) {
    if (l?.kind !== 'weekly_scoped' || typeof l.percent !== 'number' || !Number.isFinite(l.percent)) continue
    const raw = l.scope?.model?.display_name || l.scope?.surface?.display_name
    // 화면에 그대로 들어가는 이름이라 표시 문자만 남긴다(서버 응답을 HTML로 해석하지 않게).
    const label = typeof raw === 'string' ? raw.replace(/[<>&"'`]/g, '').trim().slice(0, 24) : ''
    if (!label) continue
    const used = Math.max(0, Math.min(100, Math.round(l.percent)))
    const resetTime = typeof l.resets_at === 'string' && Number.isFinite(Date.parse(l.resets_at)) ? l.resets_at : undefined
    out.push({ label, quota: { percentUsed: used, percentLeft: 100 - used, remainingFraction: (100 - used) / 100, resetTime, resetCountdown: formatCountdown(resetTime), isExhausted: used >= 100 } })
  }
  return out
}

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000

export class ClaudeRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Claude 사용량 API 요청 제한 (HTTP 429, ${Math.ceil(retryAfterMs / 1000)}초 후 재시도)`)
  }
}

// Retry-After는 초 단위 숫자 또는 HTTP 날짜. 없거나 이상하면 5분 쉰다
export function parseRetryAfterMs(header: string | null, now = Date.now()): number {
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
    const date = Date.parse(header)
    if (Number.isFinite(date) && date > now) return date - now
  }
  return DEFAULT_RATE_LIMIT_BACKOFF_MS
}

export async function fetchClaudeDesktopLiveUsage(account: AccountConfig): Promise<AccountUsage> {
  if (process.platform !== 'win32' && process.platform !== 'linux') throw new Error('Claude 앱 OAuth 조회는 Windows·Linux에서 지원됩니다')
  const failures: string[] = []
  for (const dir of findClaudeDataDirs()) {
    if (!hasDesktopSession(dir)) continue
    // 실패 사유는 단계 이름만 남긴다. 예외 메시지에는 복호화된 내용 일부가 섞일 수 있어 그대로 쓰지 않는다
    let step = '설정 파일 읽기'
    try {
      const config = JSON.parse(await fs.promises.readFile(path.join(dir, 'config.json'), 'utf8'))
      if (typeof config['oauth:tokenCacheV2'] !== 'string') { failures.push('tokenCacheV2 없음'); continue }
      let cache: unknown
      try { cache = await openClaudeCache(dir, config['oauth:tokenCacheV2']) }
      catch (e) { if (e instanceof StepError) { failures.push(e.bare ? e.step : `${e.step} 실패`); continue } throw e }
      step = '토큰 선택'

      let activeAccount = typeof config.lastKnownAccountUuid === 'string' && config.lastKnownAccountUuid
        ? config.lastKnownAccountUuid
        : (typeof config.activeAccountId === 'string' ? config.activeAccountId : undefined)

      if (!activeAccount && cache && typeof cache === 'object') {
        const accountIds = new Set(
          Object.keys(cache)
            .map(k => /^acct:([^|]+)\|/.exec(k)?.[1])
            .filter((id): id is string => Boolean(id))
        )
        if (accountIds.size === 1) {
          activeAccount = [...accountIds][0]
        }
      }

      const credential = selectClaudeDesktopToken(cache, activeAccount)
      step = '사용량 API 호출'
      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${credential.token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
        signal: AbortSignal.timeout(5000), redirect: 'error'
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        if (response.status === 429) throw new ClaudeRateLimitError(parseRetryAfterMs(response.headers.get('retry-after')))
        failures.push(`사용량 API HTTP ${response.status}`)
        continue
      }
      step = '사용량 응답 파싱'
      return parseClaudeDesktopLiveUsage(await response.json(), account, credential.subscriptionType)
    } catch (err) {
      if (err instanceof ClaudeRateLimitError) throw err
      failures.push(`${step} 실패`)
    }
  }
  throw new Error(`Claude 앱 실시간 세션 조회 실패: ${failures.join(', ') || '데이터 폴더 없음'}`)
}
