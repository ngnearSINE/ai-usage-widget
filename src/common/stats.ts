import type { HistoryPoint } from './types.js'
import type { HistoryStore } from './history.js'

/**
 * 사용량 통계. 단위는 모두 '주간 한도의 %'다(하루에 주간 한도를 15% 썼다, 한 주에 80% 썼다).
 * 기록 표본의 주간 남은 %가 줄어든 만큼을 그 표본의 날짜(이 PC 시간)에 더한다. 남은 양이 늘면(리셋) 더하지 않는다.
 * 원본 기록은 30일만 두므로 날짜별 합계를 따로 1년 보관한다.
 */
export type DailyStore = Record<string, Record<string, number>> // 계정 → 'YYYY-MM-DD' → 그날 쓴 주간 한도 %
export const DAILY_KEEP_DAYS = 366
export type Period = 'day' | 'week' | 'month'
export const PERIOD_COUNT: Record<Period, number> = { day: 30, week: 12, month: 12 }

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const round1 = (n: number) => Math.round(n * 10) / 10

/** 앞뒤 표본 사이에 쓴 주간 한도 %. 값이 없거나 남은 양이 그대로·늘었으면(리셋) 0. */
export const usedBetween = (prev: number | null | undefined, next: number | null | undefined) =>
  prev == null || next == null || next >= prev ? 0 : prev - next

/** 새 표본 하나를 날짜별 합계에 더한다. */
export function addUsage(daily: DailyStore, id: string, prev: HistoryPoint | undefined, next: HistoryPoint) {
  const used = usedBetween(prev?.[2], next[2])
  if (used <= 0) return false
  const days = daily[id] ||= {}, key = dayKey(next[0])
  days[key] = round1((days[key] || 0) + used)
  return true
}

/** 원본 기록으로 날짜별 합계를 만든다(처음 켤 때 남아 있는 최근 30일을 채우는 데 쓴다). */
export function dailyFromHistory(store: HistoryStore): DailyStore {
  const daily: DailyStore = {}
  for (const [id, list] of Object.entries(store)) for (let i = 1; i < list.length; i++) addUsage(daily, id, list[i - 1], list[i])
  return daily
}

/** 1년이 지난 날짜를 버린다. */
export function pruneDaily(daily: DailyStore, now = Date.now()): DailyStore {
  const cut = dayKey(now - DAILY_KEEP_DAYS * 86400e3), out: DailyStore = {}
  for (const [id, days] of Object.entries(daily)) {
    const kept = Object.fromEntries(Object.entries(days).filter(([k]) => k >= cut))
    if (Object.keys(kept).length) out[id] = kept
  }
  return out
}

export interface Bucket { start: number; label: string; tip: string; total: number; days: number }

/** 칸의 시작 시각(이 PC 시간): 하루는 자정, 한 주는 월요일 자정, 한 달은 1일 자정. */
function startOf(period: Period, t: number) {
  const d = new Date(t); d.setHours(0, 0, 0, 0)
  if (period === 'week') d.setDate(d.getDate() - (d.getDay() + 6) % 7)
  if (period === 'month') d.setDate(1)
  return d
}
function shift(period: Period, d: Date, n: number) {
  const x = new Date(d)
  if (period === 'day') x.setDate(x.getDate() + n)
  else if (period === 'week') x.setDate(x.getDate() + 7 * n)
  else x.setMonth(x.getMonth() + n)
  return x
}

/** 최근 count칸(오늘·이번 주·이번 달까지)의 합계. 칸마다 그 안에 든 날짜를 더한다. */
export function buckets(days: Record<string, number> | undefined, period: Period, now = Date.now(), count = PERIOD_COUNT[period]): Bucket[] {
  const last = startOf(period, now), out: Bucket[] = []
  for (let i = count - 1; i >= 0; i--) {
    const s = shift(period, last, -i), e = shift(period, s, 1)
    const from = dayKey(s.getTime()), to = dayKey(e.getTime())
    let total = 0
    for (const [k, v] of Object.entries(days || {})) if (k >= from && k < to) total += v
    const md = `${s.getMonth() + 1}/${s.getDate()}`
    const end = new Date(e.getTime() - 86400e3)
    out.push({
      start: s.getTime(),
      label: period === 'month' ? `${s.getMonth() + 1}월` : md,
      tip: period === 'day' ? `${md}(${'일월화수목금토'[s.getDay()]})` : period === 'week' ? `${md}~${end.getMonth() + 1}/${end.getDate()}` : `${s.getFullYear()}년 ${s.getMonth() + 1}월`,
      total: round1(total),
      days: Math.round((Math.min(e.getTime(), startOf('day', now).getTime() + 86400e3) - s.getTime()) / 86400e3),
    })
  }
  return out
}

/** 미리보기용 합성 기록: 서비스마다 하루 사용량이 다르고 주말엔 적게 쓴다(1년치). */
export function previewDaily(ids: string[], now = Date.now()): DailyStore {
  const out: DailyStore = {}
  ids.forEach((id, i) => {
    const days: Record<string, number> = {}
    for (let d = 0; d < DAILY_KEEP_DAYS - 1; d++) {
      const t = now - d * 86400e3, wd = new Date(t).getDay(), weekend = wd === 0 || wd === 6
      const v = (6 + i * 4 + 5 * Math.sin(d / 9 + i) + 3 * Math.sin(d / 2.3 + i * 2)) * (weekend ? .35 : 1)
      if (v > .5) days[dayKey(t)] = round1(v)
    }
    out[id] = days
  })
  return out
}
