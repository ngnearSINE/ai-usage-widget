import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { CostTokens } from '../common/cost.js'

/**
 * API 요금 환산용 토큰 집계. Claude Code(~/.claude/projects)와 Codex(~/.codex/sessions)가 이 PC에 남긴 기록(jsonl)을 읽어
 * 날짜(로컬)·모델별 토큰을 모은다. 기록이 수 GB라 한 번 읽은 파일은 크기·읽은 위치를 기억해 두고 새로 덧붙은 줄만 읽는다(cost-cache.json).
 * 기록에서는 토큰 수만 꺼내고 대화 내용은 저장하지 않는다.
 * - Claude: assistant 메시지의 message.usage. 같은 응답이 여러 줄·여러 파일(이어 하기)에 반복되므로 message.id+requestId로 한 번만 센다.
 * - Codex: event_msg/token_count의 누적값(total_token_usage) 차이. 모델은 그 파일의 마지막 turn_context.
 */
const CACHE_VERSION = 1

export type CostSource = 'claude' | 'codex'
type Daily = Record<string, Record<string, CostTokens>> // 날짜 → 모델 → 토큰
interface FileState {
  source: CostSource; size: number; offset: number; daily: Daily
  model?: string; total?: { input: number; cached: number; output: number } // Codex 이어 읽기용
}
interface Cache { version: number; files: Record<string, FileState>; seen: Record<string, string> } // seen: Claude 응답 지문 → 그 응답을 센 파일

export interface ScanProgress { scanning: boolean; done: number; total: number }

const zero = (): CostTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
const localDate = (iso: string) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '' }
const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0

function add(daily: Daily, date: string, model: string, t: Partial<CostTokens>) {
  if (!date) return
  const day = daily[date] ||= {}, m = day[model] ||= zero()
  for (const k of Object.keys(t) as Array<keyof CostTokens>) m[k] += t[k] || 0
}

/** 폴더 아래 jsonl 파일(깊이 제한). Claude 워크플로의 하위 에이전트 기록은 다섯 단계 아래에 있다. */
function listJsonl(root: string, depth = 8): string[] {
  const out: string[] = []
  const walk = (dir: string, d: number) => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory() && d < depth) walk(p, d + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(root, 0)
  return out
}

export class CostScanner {
  private cache: Cache = { version: CACHE_VERSION, files: {}, seen: {} }
  private running: Promise<void> | null = null
  private saveTimer: NodeJS.Timeout | undefined
  public progress: ScanProgress = { scanning: false, done: 0, total: 0 }

  constructor(private readonly cacheFile: string, private readonly roots: () => Array<{ source: CostSource; dir: string }>) {
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Cache
      if (saved?.version === CACHE_VERSION && saved.files) this.cache = { version: CACHE_VERSION, files: saved.files, seen: saved.seen || {} }
    } catch { /* 처음이거나 읽지 못함: 처음부터 읽는다 */ }
  }

  /** 지금까지 모은 날짜·모델별 토큰(서비스별). */
  public totals(): Record<CostSource, Daily> {
    const out: Record<CostSource, Daily> = { claude: {}, codex: {} }
    for (const f of Object.values(this.cache.files)) for (const [date, models] of Object.entries(f.daily)) for (const [model, t] of Object.entries(models)) add(out[f.source], date, model, t)
    return out
  }

  /** 새로 생기거나 덧붙은 기록을 읽는다. 여러 번 불러도 한 번만 돈다. */
  public scan(): Promise<void> {
    this.running ||= this.run().finally(() => { this.running = null; this.progress = { ...this.progress, scanning: false }; this.save(0) })
    return this.running
  }

  private async run() {
    const files: Array<{ source: CostSource; file: string; size: number }> = []
    for (const { source, dir } of this.roots()) for (const file of listJsonl(dir)) {
      try { files.push({ source, file, size: fs.statSync(file).size }) } catch { /* 사라짐 */ }
    }
    const live = new Set(files.map(f => f.file))
    for (const f of Object.keys(this.cache.files)) if (!live.has(f)) delete this.cache.files[f] // 지운 기록은 합계에서도 뺀다
    const todo = files.filter(f => this.cache.files[f.file]?.size !== f.size)
    // 읽을 새 기록이 없으면 '읽는 중'으로 두지 않는다(통계 창이 끝없이 다시 묻지 않게).
    this.progress = { scanning: todo.length > 0, done: 0, total: todo.length }
    for (const f of todo) {
      try { await this.readFile(f.source, f.file, f.size) } catch { /* 이 파일은 다음에 다시 */ }
      this.progress = { ...this.progress, done: this.progress.done + 1 }
      if (this.progress.done % 20 === 0) this.save()
    }
  }

  /** 파일의 새 부분만 읽는다. 파일이 줄었으면(다시 쓰임) 처음부터. 마지막 줄이 아직 쓰이는 중이면 다음에 읽는다. */
  private async readFile(source: CostSource, file: string, size: number) {
    let st = this.cache.files[file]
    if (!st || st.source !== source || size < st.offset) {
      if (st) for (const [k, owner] of Object.entries(this.cache.seen)) if (owner === file) delete this.cache.seen[k]
      st = { source, size: 0, offset: 0, daily: {} }
    }
    const start = st.offset
    if (size <= start) { st.size = size; this.cache.files[file] = st; return }
    let carry = '', pos = start
    const stream = fs.createReadStream(file, { start, end: size - 1, encoding: 'utf8', highWaterMark: 1 << 20 })
    for await (const chunk of stream as AsyncIterable<string>) {
      const text = carry + chunk
      const last = text.lastIndexOf('\n')
      if (last < 0) { carry = text; continue }
      for (const line of text.slice(0, last).split('\n')) this.line(source, file, st, line)
      pos += Buffer.byteLength(text.slice(0, last + 1), 'utf8')
      carry = text.slice(last + 1)
    }
    st.offset = pos
    st.size = size
    this.cache.files[file] = st
  }

  private line(source: CostSource, file: string, st: FileState, line: string) {
    if (source === 'claude') {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) return
      let j: any
      try { j = JSON.parse(line) } catch { return }
      const m = j?.message, u = m?.usage
      if (j?.type !== 'assistant' || !u || typeof m?.model !== 'string' || m.model === '<synthetic>') return
      if (m.id && j.requestId) {
        const key = createHash('sha1').update(`${m.id}:${j.requestId}`).digest('base64').slice(0, 12)
        // 이미 센 응답(같은 파일의 앞줄이든 이어 하기로 복사된 다른 파일이든)은 건너뛴다. 파일을 처음부터 다시 읽을 땐 그 파일 몫을 먼저 지운다.
        if (this.cache.seen[key]) return
        this.cache.seen[key] = file
      }
      const w1h = n(u.cache_creation?.ephemeral_1h_input_tokens), w5m = u.cache_creation ? n(u.cache_creation.ephemeral_5m_input_tokens) : n(u.cache_creation_input_tokens)
      add(st.daily, localDate(j.timestamp), m.model, { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite5m: w5m, cacheWrite1h: w1h })
      return
    }
    if (!line.includes('"turn_context"') && !line.includes('"token_count"')) return
    let j: any
    try { j = JSON.parse(line) } catch { return }
    if (j?.type === 'turn_context' && typeof j.payload?.model === 'string') { st.model = j.payload.model; return }
    const info = j?.type === 'event_msg' && j.payload?.type === 'token_count' ? j.payload.info : null
    const total = info?.total_token_usage, last = info?.last_token_usage
    if (!total) return
    const now = { input: n(total.input_tokens), cached: n(total.cached_input_tokens), output: n(total.output_tokens) }
    const prev = st.total
    // 누적값의 차이가 이번 사용량이다. 누적이 줄었으면(새 세션으로 초기화) 마지막 한 번 값을 쓴다.
    let d = prev ? { input: now.input - prev.input, cached: now.cached - prev.cached, output: now.output - prev.output } : now
    if (d.input < 0 || d.cached < 0 || d.output < 0) d = last ? { input: n(last.input_tokens), cached: n(last.cached_input_tokens), output: n(last.output_tokens) } : { input: 0, cached: 0, output: 0 }
    st.total = now
    if (!d.input && !d.output) return
    add(st.daily, localDate(j.timestamp), st.model || 'unknown', { input: Math.max(0, d.input - d.cached), cacheRead: d.cached, output: d.output })
  }

  private save(delay = 2000) {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
        fs.writeFileSync(`${this.cacheFile}.tmp`, JSON.stringify(this.cache))
        fs.renameSync(`${this.cacheFile}.tmp`, this.cacheFile)
      } catch (err) { console.warn('[Cost] 집계 저장 실패', err) }
    }, delay)
  }
}
