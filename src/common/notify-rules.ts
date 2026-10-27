import type { AccountUsage, WidgetConfig } from './types.js'
import { fmtDuration, paceWarning, PERIOD_LEN, serviceModel, unusedWeekly, windowsOf, type QuotaWindow } from './usage-model.js'

/**
 * 알림 판정. 사용량이 갱신될 때마다 호출되며, 같은 리셋 주기 안에서는 종류별로 한 번만 알린다.
 * - low: 남은 양이 주의·위험 기준에 처음 닿을 때(바로 위험이면 위험만)
 * - pace: 대시보드 '속도 주의'와 같은 조건이 처음 될 때(이미 부족 알림을 보냈으면 생략)
 * - reset: 그 주기에 주의 기준 아래였던 한도가 새로 채워졌을 때
 */
export type NotifyKind = 'warn' | 'crit' | 'pace' | 'reset' | 'unused'
export interface NotifyEvent { key: string; accountId: string; kind: NotifyKind; title: string; body: string }
export interface WindowRecord { resetAt: number | null; period: string; sent: NotifyKind[]; tight: boolean; left: number }
export type NotifyState = Record<string, WindowRecord>

const PERIOD_SLACK = 30 * 60e3 // 리셋 시각이 조회마다 조금씩 흔들려도 같은 주기로 본다.

function periodOf(w: QuotaWindow, now: number, prev?: WindowRecord): { resetAt: number | null; period: string } {
  const len = PERIOD_LEN[w.period], bucket = `b${Math.floor(now / len)}`
  if (w.resetMs === null) {
    // 리셋 시각이 잠깐 빠진 조회는 지난번 주기를 이어 간다(새 주기로 보면 같은 알림이 다시 나간다).
    if (prev && (prev.resetAt === null ? prev.period === bucket : prev.resetAt > now)) return { resetAt: prev.resetAt, period: prev.period }
    // 리셋 시각을 모르면 주기 길이 단위로 나눈 칸을 주기로 쓴다.
    return { resetAt: null, period: bucket }
  }
  const resetAt = now + w.resetMs
  // 리셋 시각을 몰라 칸으로 이어 오던 주기에 시각이 다시 생기면 같은 주기로 이어 간다.
  if (prev && prev.resetAt === null && prev.period === bucket) return { resetAt, period: prev.period }
  if (prev?.resetAt != null && Math.abs(resetAt - prev.resetAt) < PERIOD_SLACK) return { resetAt, period: prev.period }
  return { resetAt, period: `r${Math.round(resetAt / 60e3)}` }
}

/** 지금이 알림 쉬는 시간인지(시작 ≤ 지금 < 끝, 끝이 시작보다 이르면 자정을 넘는 구간). */
export function inQuietHours(q: WidgetConfig['notifyQuiet'], now = new Date()): boolean {
  if (!q?.enabled) return false
  const min = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }
  const t = now.getHours() * 60 + now.getMinutes(), a = min(q.start), b = min(q.end)
  return a === b ? false : a < b ? t >= a && t < b : t >= a || t < b
}

export const muteKey = (accountId: string, key: '5h' | 'weekly') => `${accountId}:${key}`

export function evaluateNotifications(usages: AccountUsage[], config: WidgetConfig, prev: NotifyState, now = Date.now()): { events: NotifyEvent[]; state: NotifyState } {
  const state: NotifyState = { ...prev }
  const events: NotifyEvent[] = []
  const enabled = config.notifyEnabled !== false
  const warn = Math.max(1, Math.min(60, config.warnPercent ?? 20)), crit = Math.max(0, Math.min(warn, config.critPercent ?? 10))
  const muted = new Set(config.notifyMuted || [])
  for (const u of usages) {
    const m = serviceModel(u, now)
    // 조회 실패·갱신 지연·추정 값으로는 알리지 않는다(지난 값이나 어림값이 알림을 만들지 않게).
    if (u.status !== 'ready' || u.isEstimated) continue
    for (const w of windowsOf(m)) {
      const key = muteKey(u.id, w.key), old = state[key]
      const { resetAt, period } = periodOf(w, now, old)
      const samePeriod = old?.period === period
      const rec: WindowRecord = samePeriod ? { ...old, resetAt, sent: [...old.sent], left: w.left } : { resetAt, period, sent: [], tight: false, left: w.left }
      const send = (kind: NotifyKind, title: string, body: string) => {
        rec.sent.push(kind)
        if (enabled && !muted.has(key)) events.push({ key, accountId: u.id, kind, title, body })
      }
      const name = `${u.name} ${w.label} 한도`
      const resetText = w.resetMs === null ? '' : `리셋까지 ${fmtDuration(w.resetMs)}`
      const paceText = w.runsOut && w.toEmptyMs !== null ? `지금 속도면 ${fmtDuration(w.toEmptyMs)} 뒤 소진 예상` : ''
      // 새 주기로 넘어왔고 지난 주기에 빠듯했으며 실제로 다시 채워졌다면 리셋 알림.
      if (!samePeriod && old?.tight && w.left > old.left && config.notifyReset === true) {
        send('reset', `${name}가 새로 채워졌어요`, [`남은 양 ${w.left}%`, w.resetMs === null ? '' : `다음 리셋 ${fmtDuration(w.resetMs)} 뒤`].filter(Boolean).join(' · '))
      }
      const lowOn = config.notifyLow !== false
      if (w.left <= crit && !rec.sent.includes('crit')) {
        if (lowOn) send('crit', `${name} ${w.left}% 남음`, [resetText, paceText].filter(Boolean).join(' · ') || '여유가 거의 없어요')
        else rec.sent.push('crit')
        if (!rec.sent.includes('warn')) rec.sent.push('warn')
      } else if (w.left <= warn && !rec.sent.includes('warn')) {
        if (lowOn) send('warn', `${name} ${w.left}% 남음`, [resetText, paceText].filter(Boolean).join(' · ') || '여유가 줄었어요')
        else rec.sent.push('warn')
      }
      if (paceWarning(w) && !rec.sent.includes('pace') && !rec.sent.includes('warn')) {
        if (config.notifyPace !== false) send('pace', `${name}, 리셋 전에 바닥날 수 있어요`, [paceText, resetText, `남은 양 ${w.left}%`].filter(Boolean).join(' · '))
        else rec.sent.push('pace')
      }
      // 주간 리셋이 임박했는데 많이 남았으면 한 번 안내한다.
      if (w.key === 'weekly' && unusedWeekly(m) === w && !rec.sent.includes('unused')) {
        if (config.notifyUnused !== false) send('unused', `${u.name} 주간 여유 ${w.left}%가 곧 초기화돼요`, `리셋까지 ${fmtDuration(w.resetMs)} · 남은 여유를 쓰려면 지금이 좋아요`)
        else rec.sent.push('unused')
      }
      if (w.left <= warn) rec.tight = true
      state[key] = rec
    }
  }
  return { events, state }
}
