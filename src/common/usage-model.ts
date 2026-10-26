import type { AccountUsage, QuotaInfo } from './types.js'

/** 대시보드 디자인과 그 디자인이 크기에 따라 바뀌는 규칙. 렌더러와 테스트가 함께 쓰는 순수 계산만 둔다. */
export const WINDOW_5H = 5 * 3600e3
export const WINDOW_7D = 7 * 86400e3
export type DesignId = 'rich' | 'numeral' | 'bars' | 'rings' | 'timeline' | 'battery'
export type ValueSource = 'weekly' | '5h' | 'tight'
export const DESIGNS: Array<[DesignId, string, string]> = [
  ['rich', '종합', '크기에 맞춰 정보 조율'], ['numeral', '숫자', '큰 숫자'], ['bars', '막대', '막대 + 페이스'],
  ['rings', '원형', '이중 링 게이지'], ['timeline', '타임라인', '시간 vs 남은 양'], ['battery', '배터리', '칸으로 세는 여유'],
]
export const SOURCE_LABEL: Record<ValueSource, string> = { weekly: '주간', '5h': '5시간', tight: '빠듯한 쪽' }

export interface QuotaWindow {
  key: '5h' | 'weekly'
  label: string
  short: string
  left: number
  used: number
  resetMs: number | null
  /** 리셋 주기에서 지난 비율(0~1). 리셋 시각을 모르면 null. */
  elapsed: number | null
  /** 지금 시점에 남아 있어야 할 양(%) = 페이스 눈금. */
  expectedLeft: number | null
  /** 지금 속도로 바닥날 때까지 남은 시간. */
  toEmptyMs: number | null
  runsOut: boolean
  pace: number | null
}
export interface ServiceModel {
  id: string
  name: string
  provider: string
  brand: string
  available: boolean
  w5?: QuotaWindow
  ww?: QuotaWindow
}

const clampPct = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0

export function quotaWindow(q: QuotaInfo, key: '5h' | 'weekly', now = Date.now()): QuotaWindow {
  const len = key === '5h' ? WINDOW_5H : WINDOW_7D
  const parsed = q.resetTime ? Date.parse(q.resetTime) - now : q.timeUntilResetMs
  const resetMs = Number.isFinite(parsed) && parsed! >= 0 ? Math.min(parsed!, len) : null
  const left = clampPct(q.percentLeft), used = 100 - left
  const elapsed = resetMs === null ? null : Math.max(.02, Math.min(1, 1 - resetMs / len))
  const rate = elapsed === null ? 0 : used / (elapsed * len)
  const toEmptyMs = elapsed === null ? null : rate > 0 ? left / rate : Infinity
  return {
    key, label: key === '5h' ? '5시간' : '주간', short: key === '5h' ? '5h' : '주',
    left, used, resetMs, elapsed,
    expectedLeft: elapsed === null ? null : Math.round((1 - elapsed) * 100),
    toEmptyMs, runsOut: used > 0 && toEmptyMs !== null && resetMs !== null && toEmptyMs < resetMs,
    pace: elapsed === null ? null : used / 100 / elapsed,
  }
}

export function serviceModel(u: AccountUsage, now = Date.now()): ServiceModel {
  // 주간 전용 계정은 기본 한도가 곧 주간 한도다.
  const w5 = u.isWeeklyOnly ? undefined : quotaWindow(u.primaryQuota, '5h', now)
  const ww = u.isWeeklyOnly ? quotaWindow(u.primaryQuota, 'weekly', now) : u.weeklyQuota ? quotaWindow(u.weeklyQuota, 'weekly', now) : undefined
  return { id: u.id, name: u.name, provider: u.provider, brand: u.brandColor, available: ['ready', 'stale'].includes(u.status), w5, ww }
}

export const windowsOf = (m: ServiceModel) => [m.w5, m.ww].filter(Boolean) as QuotaWindow[]

/** 큰 숫자 기준. 고른 한도가 없는 계정(주간 전용 등)은 있는 쪽을 쓴다. */
export function pickWindow(m: ServiceModel, source: ValueSource = 'weekly'): { main: QuotaWindow; other?: QuotaWindow } {
  const ws = windowsOf(m)
  let main = source === '5h' ? m.w5 : source === 'tight' ? [...ws].sort((a, b) => a.left - b.left)[0] : m.ww
  main ||= ws[0]
  return { main, other: ws.find(w => w !== main) }
}

export function lowestLeft(m: ServiceModel) { return Math.min(...windowsOf(m).map(w => w.left), 100) }

/**
 * 속도만으로 '주의'를 띄우는 조건. 사용은 몰아서 일어나는 경우가 많아 단순 선형 예측은 자주 '소진'을 말한다.
 * 리셋보다 주기의 15% 이상 먼저 바닥날 것으로 보이고 남은 양이 절반 이하일 때만 강조한다(문장 안내는 별도로 항상 보인다).
 */
export function paceWarning(w: QuotaWindow) {
  if (!w.runsOut || w.resetMs === null || w.toEmptyMs === null) return false
  const len = w.key === '5h' ? WINDOW_5H : WINDOW_7D
  return w.resetMs - w.toEmptyMs >= len * .15 && w.left <= 50
}

export function severity(m: ServiceModel, warn: number, crit: number): '' | 'warn' | 'crit' {
  if (!m.available || !windowsOf(m).length) return ''
  const low = lowestLeft(m)
  if (low <= crit) return 'crit'
  if (low <= warn || windowsOf(m).some(paceWarning)) return 'warn'
  return ''
}

/** 주간 리셋이 24시간 안에 다가왔는데 40% 이상 남은 경우(남는 여유 안내). */
export function unusedWeekly(m: ServiceModel) {
  const w = m.ww
  return w && w.resetMs !== null && w.resetMs <= 86400e3 && w.left >= 40 ? w : null
}

/** 가장 급한 한도: 속도 주의가 있는 쪽 우선, 다음은 남은 양이 적은 쪽. */
export function worstWindow(m: ServiceModel) {
  return [...windowsOf(m)].sort((x, y) => paceWarning(x) !== paceWarning(y) ? (paceWarning(x) ? -1 : 1) : x.left - y.left)[0]
}

/* ---------- 크기 판정 ---------- */
export type RichTier = 'xs' | 's' | 'm' | 'mw' | 'ml' | 'l' | 'lw' | 'tall'
export const TIER_NAME: Record<RichTier | 'xs2', string> = { xs: '한 줄', xs2: '두 줄', s: '간결', m: '보통', mw: '보통·넓게', ml: '풍부·간결', l: '풍부', lw: '풍부(요약 왼쪽)', tall: '세로' }
const TIER_RANK: Record<string, number> = { xs: 1, xs2: 1.8, s: 2, tall: 2.5, m: 3, mw: 4, ml: 4, l: 4.5, lw: 5 }
// 각 단계 내용이 기본 크기에서 차지하는 높이(px). 남는 높이를 여백으로 본다.
const TIER_NEED: Record<string, number> = { xs: 24, xs2: 36, s: 58, m: 86, mw: 86, ml: 166, l: 212, lw: 124, tall: 170 }

/** 카드 제목줄(28px)은 높이 60 미만이면 두지 않는다. */
export function cardBody(cw: number, ch: number) {
  const head = ch < 60 ? 0 : 28
  return { bw: cw - 24, bh: ch - 20 - head }
}

export function richTier(bw: number, bh: number): RichTier {
  if (bw >= 90 && bw < 150 && bh >= 170) return 'tall'
  if (bh < 40 || bw < 120) return 'xs'
  if (bh < 84) return 's'
  if (bh < 136) return bw >= 330 ? 'mw' : 'm'
  if (bw >= Math.max(380, bh * 1.9)) return 'lw'
  if (bh < 160) return bw >= 330 ? 'mw' : 'm'
  return bh >= 210 ? 'l' : 'ml'
}

/** 큰 카드에서는 숫자·글자·막대를 함께 키운다(최대 1.35배). */
export const richScale = (bw: number, bh: number) => Math.max(1, Math.min(1.35, bw / 380, bh / (bw >= 380 ? 150 : 240)))

// 다른 디자인이 그림을 그리는 기본 상자(가로형 h / 세로형 v).
export const DESIGN_SPEC: Record<Exclude<DesignId, 'rich'>, { h: [number, number]; v: [number, number] }> = {
  numeral: { h: [150, 70], v: [110, 120] }, bars: { h: [220, 84], v: [90, 150] }, rings: { h: [230, 140], v: [140, 180] },
  timeline: { h: [300, 112], v: [110, 260] }, battery: { h: [220, 96], v: [150, 180] },
}
/** 비율을 지켜 최대 1.5배까지 키웠을 때의 배율·덮는 면적·방향. */
export function fitDesign(d: Exclude<DesignId, 'rich'>, bw: number, bh: number) {
  let best = { s: 0, area: 0, o: 'h' as 'h' | 'v' }
  for (const o of ['h', 'v'] as const) {
    const [w0, h0] = DESIGN_SPEC[d][o], s = Math.min(bw / w0, bh / h0), k = Math.min(s, 1.5), area = w0 * k * h0 * k
    if (area > best.area) best = { s, area, o }
  }
  return best
}

/** 기본 형태가 들어가지 않으면 작은 카드 형태. 다른 디자인으로 바꿔 그리지 않는다. */
export function formOf(design: DesignId, cw: number, ch: number): 'full' | 'compact' {
  const { bw, bh } = cardBody(cw, ch)
  if (design === 'rich') return richTier(bw, bh) === 'xs' ? 'compact' : 'full'
  return ch >= 60 && fitDesign(design, bw, bh).s >= .75 ? 'full' : 'compact'
}

export interface GridLayout { cols: number; rows: number; cw: number; ch: number; per: number; tier?: RichTier | 'xs2' }

/**
 * 열 수마다 카드 크기를 계산해 가장 좋은 배치를 고른다.
 * 종합: 단계가 높을수록 좋고, 카드 안에 남는 높이·빈 칸·지나치게 좁은 카드는 감점.
 * 다른 디자인: 기본 형태가 들어가면 여백이 가장 적은 배치, 아니면 작은 카드가 넉넉해지는 배치.
 * 어떤 배치로도 들어가지 않으면 한 페이지에 들어가는 만큼만 보여 주고 나머지는 페이지로 넘긴다.
 */
export function chooseLayout(W: number, H: number, n: number, design: DesignId, gap = 6): GridLayout {
  let best: (GridLayout & { score: number }) | null = null
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols), cw = (W - gap * (cols - 1)) / cols, ch = (H - gap * (rows - 1)) / rows, spare = rows * cols - n
    if (cw < 90 || ch < 30) continue
    const { bw, bh } = cardBody(cw, ch)
    let score: number, tier: RichTier | 'xs2' | undefined
    if (design === 'rich') {
      const raw = richTier(bw, bh)
      tier = raw === 'xs' && ch >= 48 && cw >= 140 ? 'xs2' : raw
      const need = TIER_NEED[tier] * Math.min(richScale(bw, bh), 1.35), waste = Math.max(0, 1 - need / bh)
      score = TIER_RANK[tier] * 10 - waste * 20 - Math.abs(Math.log(cw / ch / 2.5)) - spare * 1.5 - (cw < 150 ? 8 : 0) - (ch < 34 ? 30 : 0)
    } else {
      const f = fitDesign(design, bw, bh)
      if (formOf(design, cw, ch) === 'full') {
        let area = f.area * (n - (spare ? 1 : 0))
        if (spare) area += fitDesign(design, cw * (spare + 1) + gap * spare - 24, bh).area
        score = 100 + area / (W * H) * 50
      } else {
        score = 50 + Math.min(1, cw / 320) * 20 - Math.abs(Math.log(Math.min(ch, 80) / 64)) * 10 - (ch > 110 && cw >= 170 ? 15 : 0) - (cw < 120 ? 30 : 0) - spare * 3
      }
    }
    if (!best || score > best.score) best = { cols, rows, cw, ch, per: n, tier, score }
  }
  if (best) { const { score: _s, ...layout } = best; return layout }
  const cols = Math.max(1, Math.floor((W + gap) / (120 + gap))), rows = Math.max(1, Math.floor((H + gap) / (34 + gap)))
  const per = Math.max(1, Math.min(n, cols * rows))
  if (per >= n) return { cols: Math.min(cols, n), rows: Math.ceil(n / Math.min(cols, n)), cw: W / Math.min(cols, n), ch: H / Math.ceil(n / Math.min(cols, n)), per: n }
  return { ...chooseLayout(W, H, per, design, gap), per }
}

export const fmtDuration = (ms: number | null) => {
  if (ms === null || !Number.isFinite(ms)) return '—'
  const m = Math.max(1, Math.round(ms / 60e3)), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), mm = m % 60
  return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${mm}분` : `${mm}분`
}
export const fmtDurationShort = (ms: number | null) => {
  if (ms === null || !Number.isFinite(ms)) return '—'
  const m = Math.max(1, Math.round(ms / 60e3)), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), mm = m % 60
  return d ? `${d}일 ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`
}
