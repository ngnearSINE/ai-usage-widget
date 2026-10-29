import { formatCountdown } from '../common/time-utils.js'
import type { AccountConfig, AccountUsage, QuotaInfo } from '../common/types.js'

/** 사용한 비율(%)과 리셋 시각으로 한도 칸을 만든다. */
export function quotaFromUsed(percentUsed: number, resetTime?: string): QuotaInfo {
  const used = Math.max(0, Math.min(100, Math.round(percentUsed)))
  return { remainingFraction: (100 - used) / 100, percentLeft: 100 - used, percentUsed: used, resetTime, resetCountdown: formatCountdown(resetTime), isExhausted: used >= 100 }
}

/** 조회에 실패한 카드. 마지막 실측값은 상위(retainedUsage)가 '갱신 지연'으로 이어 보여 준다. */
export function failedUsage(account: AccountConfig, brand: { name: string; letter: string; color: string }, status: 'error' | 'unauthenticated', message: string): AccountUsage {
  return {
    id: account.id, name: account.name || brand.name, provider: account.provider, iconLetter: brand.letter, brandColor: brand.color,
    status, errorMessage: message,
    primaryQuota: { remainingFraction: 1, percentLeft: 100, percentUsed: 0, resetCountdown: '--' },
    updatedAt: new Date().toISOString(),
  }
}

export const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
export const iso = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined

/** JWT 본문(서명은 확인하지 않는다. 만료 시각·사용자 ID를 읽는 데만 쓴다). */
export function jwtPayload(token: string): Record<string, any> | null {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) } catch { return null }
}
