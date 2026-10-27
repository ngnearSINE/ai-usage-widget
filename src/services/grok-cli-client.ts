import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatCountdown } from '../common/time-utils.js'
import type { AccountConfig, AccountUsage, QuotaInfo } from '../common/types.js'

/**
 * Grok 사용량. Grok CLI가 로그인해 둔 토큰(~/.grok/auth.json)을 읽기만 하고,
 * CLI가 쓰는 billing 경로(공식 문서에 없는 경로)로 주간 사용률과 월간 크레딧을 조회한다.
 * 토큰은 갱신하지 않는다 — 위젯이 갱신하면 CLI의 갱신 토큰이 바뀌어 CLI 로그인이 끊길 수 있다.
 * 만료되면 grok을 한 번 실행하라고 안내하고, 마지막 실측값은 상위(retainedUsage)가 지연 상태로 보여 준다.
 */
const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing'
const TIMEOUT_MS = 8000
const BRAND = '#A1A1AA'

export const GROK_TEXT = {
  notLoggedIn: 'Grok CLI 로그인이 필요합니다 (grok login)',
  expired: 'Grok 로그인이 만료됐어요. 터미널에서 grok을 한 번 실행하면 갱신됩니다',
  unavailable: 'Grok 사용량 정보를 받지 못했습니다',
} as const

interface GrokAuth { key: string; expiresAt: number | null }

export function grokAuthPath() {
  return path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'auth.json')
}

/** auth.json은 {"<발급자>::<클라이언트>": { key, expires_at, ... }} 형태다. 토큰 값은 밖으로 내보내지 않는다. */
export function readGrokAuth(file = grokAuthPath()): GrokAuth | null {
  if (!fs.existsSync(file)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, { key?: unknown; expires_at?: unknown }>
    for (const entry of Object.values(raw)) {
      if (typeof entry?.key !== 'string' || !entry.key) continue
      const exp = typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) : NaN
      return { key: entry.key, expiresAt: Number.isFinite(exp) ? exp : null }
    }
  } catch {}
  return null
}

function quota(percentUsed: number, resetTime: string | undefined): QuotaInfo {
  const used = Math.max(0, Math.min(100, Math.round(percentUsed)))
  return {
    remainingFraction: (100 - used) / 100,
    percentLeft: 100 - used,
    percentUsed: used,
    resetTime,
    resetCountdown: formatCountdown(resetTime),
    isExhausted: used >= 100,
  }
}

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
const iso = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined

/**
 * billing 응답 두 개를 카드 데이터로 바꾼다.
 * - `?format=credits`: 주간 기간이면 config.creditUsagePercent(기간 시작 직후엔 빠짐 → 0%)와 billingPeriodEnd
 * - 기본: config.monthlyLimit.val / used.val / billingPeriodEnd. 한도가 0이면 월간 크레딧이 없는 계정이다.
 * 월간이 있으면 첫 칸을 월간으로, 없으면 주간 전용 계정으로 둔다.
 */
export function grokUsageFromBilling(account: AccountConfig, monthly: unknown, credits: unknown): AccountUsage {
  const mc = (monthly as { config?: Record<string, any> } | null)?.config
  const cc = (credits as { config?: Record<string, any> } | null)?.config
  const limit = num(mc?.monthlyLimit?.val), usedCredits = num(mc?.used?.val)
  const monthlyQuota = limit && limit > 0 && usedCredits !== null ? quota(usedCredits / limit * 100, iso(mc?.billingPeriodEnd)) : undefined
  const weeklyQuota = cc?.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY'
    ? quota(num(cc.creditUsagePercent) ?? 0, iso(cc.billingPeriodEnd) || iso(cc.currentPeriod?.end)) : undefined
  if (!monthlyQuota && !weeklyQuota) throw new Error(GROK_TEXT.unavailable)
  const base = {
    id: account.id, name: account.name || 'Grok', provider: account.provider, iconLetter: 'G', brandColor: BRAND,
    tier: 'Grok CLI', status: 'ready' as const, updatedAt: new Date().toISOString(),
  }
  return monthlyQuota
    ? { ...base, primaryKind: 'monthly', primaryQuota: monthlyQuota, weeklyQuota }
    : { ...base, isWeeklyOnly: true, primaryQuota: weeklyQuota! }
}

export class GrokCliClient {
  /** Grok CLI가 설치됐거나 로그인 기록이 있는지(감지용). */
  public static isInstalled() {
    return fs.existsSync(grokAuthPath()) || fs.existsSync(path.join(os.homedir(), '.grok', 'bin', 'grok.exe'))
  }

  public static async fetchUsage(account: AccountConfig): Promise<AccountUsage> {
    // 두 번째 계정: 그 계정의 로그인 폴더(GROK_HOME)의 auth.json
    const auth = readGrokAuth(account.homeDir ? path.join(account.homeDir, 'auth.json') : grokAuthPath())
    if (!auth) return this.failed(account, 'unauthenticated', GROK_TEXT.notLoggedIn)
    if (auth.expiresAt !== null && auth.expiresAt < Date.now() + 30e3) return this.failed(account, 'error', GROK_TEXT.expired)
    const headers = { authorization: `Bearer ${auth.key}`, 'x-xai-token-auth': 'xai-grok-cli', accept: 'application/json' }
    const get = async (url: string) => {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(GROK_TEXT.expired), { auth: true })
      if (!res.ok) throw new Error(`${GROK_TEXT.unavailable} (HTTP ${res.status})`)
      return res.json()
    }
    try {
      // 월간 경로만 실패해도 주간 값은 보여 준다.
      const [monthly, credits] = await Promise.all([get(BILLING_URL).catch(err => { if (err.auth) throw err; return null }), get(`${BILLING_URL}?format=credits`)])
      return grokUsageFromBilling(account, monthly, credits)
    } catch (err: any) {
      return this.failed(account, 'error', err?.name === 'TimeoutError' ? 'Grok 응답 시간 초과' : err?.message || GROK_TEXT.unavailable)
    }
  }

  private static failed(account: AccountConfig, status: 'error' | 'unauthenticated', message: string): AccountUsage {
    return {
      id: account.id, name: account.name || 'Grok', provider: account.provider, iconLetter: 'G', brandColor: BRAND,
      status, errorMessage: message,
      primaryQuota: { remainingFraction: 1, percentLeft: 100, percentUsed: 0, resetCountdown: '--' },
      updatedAt: new Date().toISOString(),
    }
  }
}
