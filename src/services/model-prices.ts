import fs from 'node:fs'
import path from 'node:path'
import type { ModelPrice, PriceTable } from '../common/cost.js'

/**
 * 모델 가격표. LiteLLM이 공개하는 가격표(model_prices_and_context_window.json)를 하루에 한 번 받아,
 * Claude·OpenAI 계열 모델만 골라 저장해 둔다(model-prices.json). 받지 못하면 저장해 둔 표를 쓴다.
 * 가격 단위는 달러/토큰이다.
 */
const URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const MAX_AGE_MS = 24 * 3600e3
const KEEP = /^(claude|gpt|o\d|codex|chatgpt)/

interface Saved { at: string; prices: PriceTable }

/** LiteLLM 표에서 필요한 모델만 골라 우리 형식으로. 제공사 접두어(azure/ 등)가 붙은 중복은 뺀다. */
export function pickPrices(raw: Record<string, any>): PriceTable {
  const out: PriceTable = {}
  for (const [name, v] of Object.entries(raw)) {
    if (!KEEP.test(name) || typeof v?.input_cost_per_token !== 'number' || typeof v?.output_cost_per_token !== 'number') continue
    const p: ModelPrice = { input: v.input_cost_per_token, output: v.output_cost_per_token }
    if (typeof v.cache_read_input_token_cost === 'number') p.cacheRead = v.cache_read_input_token_cost
    if (typeof v.cache_creation_input_token_cost === 'number') p.cacheWrite = v.cache_creation_input_token_cost
    if (typeof v.cache_creation_input_token_cost_above_1hr === 'number') p.cacheWrite1h = v.cache_creation_input_token_cost_above_1hr
    out[name] = p
  }
  return out
}

export class ModelPrices {
  private saved: Saved | null = null
  private loading: Promise<void> | null = null

  constructor(private readonly file: string) {
    try { const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Saved; if (s?.prices) this.saved = s } catch { /* 처음 */ }
  }

  public get table(): PriceTable { return this.saved?.prices || {} }
  public get updatedAt() { return this.saved?.at }

  /** 하루가 지났으면 새로 받는다. 실패하면 지난 표를 그대로 쓴다. */
  public refresh(): Promise<void> {
    if (this.saved && Date.now() - Date.parse(this.saved.at) < MAX_AGE_MS) return Promise.resolve()
    this.loading ||= (async () => {
      try {
        const res = await fetch(URL, { signal: AbortSignal.timeout(30000), redirect: 'follow' })
        if (!res.ok) return
        const prices = pickPrices(await res.json() as Record<string, any>)
        if (Object.keys(prices).length < 10) return
        this.saved = { at: new Date().toISOString(), prices }
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.saved))
        fs.renameSync(`${this.file}.tmp`, this.file)
      } catch (err) { console.warn('[Cost] 가격표를 받지 못했어요', err) }
    })().finally(() => { this.loading = null })
    return this.loading
  }
}
