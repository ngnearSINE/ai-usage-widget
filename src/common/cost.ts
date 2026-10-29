/** API 요금 환산: 토큰 묶음과 모델 가격(달러/토큰)으로 비용을 계산한다. 메인(집계)과 렌더러(표시)가 함께 쓴다. */
export interface CostTokens { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
export interface ModelPrice { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number }
export type PriceTable = Record<string, ModelPrice>

/** 서비스별 날짜·모델 토큰과 가격표. 렌더러가 기간별로 합친다. */
export interface CostReport {
  scanning: boolean; done: number; total: number
  prices: PriceTable; pricesAt?: string
  daily: Record<'claude' | 'codex', Record<string, Record<string, CostTokens>>>
}

/**
 * 모델 이름으로 가격을 찾는다. 정확히 같은 이름 → 날짜 꼬리(-20250805 등)를 뗀 이름 → 가장 긴 앞부분이 같은 이름 순.
 * 못 찾으면 null(비용에 넣지 않고 '가격 모름'으로 따로 보여 준다).
 */
export function priceFor(model: string, table: PriceTable): ModelPrice | null {
  const m = model.toLowerCase().replace(/^(anthropic|openai)\//, '')
  if (table[m]) return table[m]
  const noDate = m.replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, '')
  if (table[noDate]) return table[noDate]
  let best = ''
  for (const k of Object.keys(table)) if (noDate.startsWith(k) && k.length > best.length && /[-.]/.test(noDate[k.length] || '-')) best = k
  return best ? table[best] : null
}

/** 토큰 묶음의 달러 비용. 캐시 값이 없는 모델은 입력 가격을 쓰고(읽기는 1/10), 1시간 캐시 쓰기 가격이 없으면 5분 가격의 1.6배. */
export function costOf(t: CostTokens, p: ModelPrice): number {
  const read = p.cacheRead ?? p.input * .1, write = p.cacheWrite ?? p.input * 1.25, write1h = p.cacheWrite1h ?? write * 1.6
  return t.input * p.input + t.output * p.output + t.cacheRead * read + t.cacheWrite5m * write + t.cacheWrite1h * write1h
}

export const tokenSum = (t: CostTokens) => t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h

/** 로컬 날짜 문자열(YYYY-MM-DD). */
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 기간 [from, to](날짜 문자열 포함) 안의 서비스 비용과 모델별 비용·토큰. 가격을 모르는 모델은 unknown에 토큰만. */
export function summarize(daily: Record<string, Record<string, CostTokens>>, prices: PriceTable, from: string, to: string) {
  let total = 0
  const models: Record<string, { cost: number; tokens: number; known: boolean }> = {}
  for (const [date, byModel] of Object.entries(daily)) {
    if (date < from || date > to) continue
    for (const [model, t] of Object.entries(byModel)) {
      const p = priceFor(model, prices), cost = p ? costOf(t, p) : 0
      const row = models[model] ||= { cost: 0, tokens: 0, known: !!p }
      row.cost += cost; row.tokens += tokenSum(t); total += cost
    }
  }
  return { total, models }
}

/** 날짜별 비용(최근 days일, 오늘 포함, 오래된 날부터). */
export function dailyCosts(daily: Record<string, Record<string, CostTokens>>, prices: PriceTable, days: number, now = new Date()): Array<{ date: string; cost: number }> {
  const out: Array<{ date: string; cost: number }> = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i), key = dayKey(d)
    out.push({ date: key, cost: summarize(daily, prices, key, key).total })
  }
  return out
}

export const usd = (v: number) => v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(3)}` : '$0'
