import fs from 'node:fs'
import path from 'node:path'
import type { AccountUsage, HistoryPoint } from '../common/types.js'
import { addSamples, downsample, type HistoryStore } from '../common/history.js'

/** 사용 기록 파일(userData/usage-history.json). 이 PC에만 남는다. */
export class UsageHistory {
  private store: HistoryStore = {}
  private saveTimer: NodeJS.Timeout | undefined

  constructor(private readonly file: string, seed?: HistoryStore) {
    if (seed) { this.store = seed; return }
    try { if (fs.existsSync(file)) this.store = JSON.parse(fs.readFileSync(file, 'utf-8')) || {} }
    catch (err) { console.warn('[History] 사용 기록을 읽지 못해 새로 시작합니다:', err) }
  }

  record(usages: AccountUsage[], now = Date.now()) {
    const { store, changed } = addSamples(this.store, usages, now)
    this.store = store
    if (changed) this.save()
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
    } catch (err) { console.warn('[History] 사용 기록을 저장하지 못했습니다:', err) }
  }
}
