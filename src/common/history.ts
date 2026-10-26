import type { AccountUsage, HistoryPoint } from './types.js'

/** 사용 기록. 조회마다 표본을 넣되 값이 그대로면 10분에 한 번만 남기고, 30일이 지난 표본은 버린다. */
export const HISTORY_KEEP_MS = 30 * 86400e3
const SAME_VALUE_GAP = 10 * 60e3
export type HistoryStore = Record<string, HistoryPoint[]>

export function samplesOf(usages: AccountUsage[], now: number): Array<[string, HistoryPoint]> {
  return usages.filter(u => u.status === 'ready' && !u.isEstimated).map(u => {
    const five = u.isWeeklyOnly ? null : Math.round(u.primaryQuota.percentLeft)
    const week = u.isWeeklyOnly ? Math.round(u.primaryQuota.percentLeft) : u.weeklyQuota ? Math.round(u.weeklyQuota.percentLeft) : null
    return [u.id, [now, five, week]] as [string, HistoryPoint]
  })
}

export function addSamples(store: HistoryStore, usages: AccountUsage[], now = Date.now()): { store: HistoryStore; changed: boolean } {
  const next: HistoryStore = { ...store }
  let changed = false
  for (const [id, p] of samplesOf(usages, now)) {
    const list = next[id] ? [...next[id]] : []
    const last = list.at(-1)
    const same = last && last[1] === p[1] && last[2] === p[2]
    if (!last || !same || now - last[0] >= SAME_VALUE_GAP) { list.push(p); changed = true }
    const cut = list.findIndex(x => x[0] >= now - HISTORY_KEEP_MS)
    if (cut > 0) { list.splice(0, cut); changed = true }
    next[id] = list
  }
  return { store: next, changed }
}

/** 구간 안의 표본을 최대 max개로 줄인다(칸마다 마지막 값). 그래프와 상태 전송용. */
export function downsample(list: HistoryPoint[], from: number, to: number, max: number): HistoryPoint[] {
  const inRange = list.filter(p => p[0] >= from && p[0] <= to)
  if (inRange.length <= max) return inRange
  const step = (to - from) / max, out: HistoryPoint[] = []
  let bucket = -1
  for (const p of inRange) {
    const b = Math.min(max - 1, Math.floor((p[0] - from) / step))
    if (b === bucket) out[out.length - 1] = p
    else { out.push(p); bucket = b }
  }
  return out
}

/** 미리보기용 합성 기록: 5시간 한도는 쓰다가 리셋되는 톱니, 주간은 서서히 줄어드는 선. */
export function previewHistory(usages: AccountUsage[], now = Date.now(), days = 7): HistoryStore {
  const out: HistoryStore = {}
  usages.forEach((u, i) => {
    const pts: HistoryPoint[] = []
    const endW = u.weeklyQuota?.percentLeft ?? 60, end5 = u.primaryQuota.percentLeft
    for (let t = now - days * 86400e3; t <= now; t += 30 * 60e3) {
      const age = (now - t) / 3600e3
      const phase = ((age + i * 1.7) % 5) / 5 // 5시간 주기
      const five = Math.round(Math.max(0, Math.min(100, age < 5 ? end5 + (100 - end5) * (age / 5) * .9 : 100 - phase * (55 + 25 * Math.sin(age / 9 + i)))))
      const week = Math.round(Math.max(0, Math.min(100, endW + (100 - endW) * Math.min(1, age / (days * 24)) + Math.sin(age / 7 + i) * 2)))
      pts.push([t, five, week])
    }
    out[u.id] = pts
  })
  return out
}
