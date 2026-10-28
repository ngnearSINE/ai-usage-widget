import fs from 'node:fs'
import path from 'node:path'
import type { AccountUsage, HistoryPoint } from '../common/types.js'
import { addSamples, downsample, samplesOf, type HistoryStore } from '../common/history.js'
import { addUsage, dailyFromHistory, pruneDaily, type DailyStore } from '../common/stats.js'

/**
 * 사용 기록 파일(userData/usage-history.json)과 날짜별 사용량 요약(usage-daily.json, 통계 창용 1년). 이 PC에만 남는다.
 * 요약 파일이 없으면 남아 있는 원본 기록(최근 30일)으로 처음 한 번 채운다.
 */
export class UsageHistory {
  private store: HistoryStore = {}
  private dailyStore: DailyStore = {}
  private saveTimer: NodeJS.Timeout | undefined

  private readonly dailyFile: string

  constructor(private readonly file: string, seed?: HistoryStore, dailySeed?: DailyStore) {
    this.dailyFile = path.join(path.dirname(file), 'usage-daily.json')
    if (seed) { this.store = seed; this.dailyStore = dailySeed || dailyFromHistory(seed); return }
    try { if (fs.existsSync(file)) this.store = JSON.parse(fs.readFileSync(file, 'utf-8')) || {} }
    catch (err) { console.warn('[History] 사용 기록을 읽지 못해 새로 시작합니다:', err) }
    try {
      if (fs.existsSync(this.dailyFile)) this.dailyStore = JSON.parse(fs.readFileSync(this.dailyFile, 'utf-8')) || {}
      else { this.dailyStore = dailyFromHistory(this.store); this.save() }
    } catch (err) { console.warn('[History] 날짜별 사용량을 읽지 못해 새로 시작합니다:', err) }
  }

  record(usages: AccountUsage[], now = Date.now()) {
    // 날짜별 사용량: 직전 표본과 비교해 줄어든 주간 남은 %를 오늘에 더한다.
    let used = false
    for (const [id, p] of samplesOf(usages, now)) used = addUsage(this.dailyStore, id, this.store[id]?.at(-1), p) || used
    const { store, changed } = addSamples(this.store, usages, now)
    this.store = store
    if (changed || used) this.save()
  }

  /** 통계 창용 날짜별 사용량(1년). */
  daily(now = Date.now()): DailyStore {
    this.dailyStore = pruneDaily(this.dailyStore, now)
    return this.dailyStore
  }

  /** 카드 추이선용: 최근 24시간을 계정당 최대 48점으로. */
  recent(now = Date.now()): Record<string, HistoryPoint[]> {
    const out: Record<string, HistoryPoint[]> = {}
    for (const [id, list] of Object.entries(this.store)) out[id] = downsample(list, now - 86400e3, now, 48)
    return out
  }

  range(id: string, from: number, to: number, max: number) { return downsample(this.store[id] || [], from, to, max) }

  private save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 2000)
  }

  /** 미뤄 둔 저장을 바로 한다(앱 종료 때). */
  flush() {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.store), 'utf-8')
      fs.renameSync(`${this.file}.tmp`, this.file)
      fs.writeFileSync(`${this.dailyFile}.tmp`, JSON.stringify(pruneDaily(this.dailyStore)), 'utf-8')
      fs.renameSync(`${this.dailyFile}.tmp`, this.dailyFile)
    } catch (err) { console.warn('[History] 사용 기록을 저장하지 못했습니다:', err) }
  }
}
