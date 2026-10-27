/**
 * 그래프 색. 평소에는 서비스의 '평소 색'(서비스 색·초록·직접 고른 색), 남은 양이 줄면 경고색.
 * - step: 주의 기준 아래에서 주황, 위험 기준 아래에서 빨강으로 한 번에 바뀐다.
 * - smooth: 50% 이상은 평소 색, 50%→주의 기준은 평소 색→주황, 주의→위험 기준은 주황→빨강으로 섞는다.
 * 돌려주는 값은 CSS 색(var·color-mix 포함)이라 style 속성으로 써야 한다.
 */
export type ColorMode = 'step' | 'smooth'
/** 막대 색 그라데이션의 색 점: 남은 양(%) 위치와 색. 색은 'brand'(서비스 평소 색)·'warn'(주황)·'danger'(빨강)·'#rrggbb'. */
export interface BarStop { at: number; color: string }
/** 기본 색 점: 여유 50%까지는 평소 색, 20%에서 주황, 10% 아래는 빨강(PPT 그라데이션처럼 사이는 섞임). */
export const DEFAULT_BAR_STOPS: BarStop[] = [{ at: 100, color: 'brand' }, { at: 50, color: 'brand' }, { at: 20, color: 'warn' }, { at: 10, color: 'danger' }, { at: 0, color: 'danger' }]
export interface BarColorOptions { on: boolean; mode?: ColorMode; warn: number; crit: number; stops?: BarStop[] }

/** 색 점 하나의 CSS 색. */
export const stopColor = (c: string, base: string) => c === 'brand' ? base : c === 'warn' ? 'var(--warn)' : c === 'danger' ? 'var(--danger)' : /^#[\da-f]{6}$/i.test(c) ? c : base

/** 저장된 색 점을 쓸 수 있게 정리: 위치 0~100, 위치 순(높은 남은 양부터), 2개 이상. */
export function normalizeStops(stops?: BarStop[]): BarStop[] {
  const list = (stops || []).filter(s => s && Number.isFinite(s.at) && typeof s.color === 'string').map(s => ({ at: Math.max(0, Math.min(100, Math.round(s.at))), color: s.color }))
  return (list.length >= 2 ? list : DEFAULT_BAR_STOPS).slice().sort((a, b) => b.at - a.at)
}

/** 남은 양에 맞는 색. 부드럽게: 앞뒤 색 점 사이를 oklab으로 섞는다. 한 번에: 남은 양이 색 점 위치에 닿는 순간 그 색으로. */
export function gradientColor(left: number, base: string, stops?: BarStop[], mode: ColorMode = 'smooth'): string {
  const s = normalizeStops(stops)
  if (left >= s[0].at) return stopColor(s[0].color, base)
  if (mode === 'step') { const hit = [...s].reverse().find(x => x.at >= left)!; return stopColor(hit.color, base) }
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i], b = s[i + 1]
    if (left <= a.at && left >= b.at) {
      const t = a.at === b.at ? 1 : (a.at - left) / (a.at - b.at), p = Math.round(t * 100)
      const ca = stopColor(a.color, base), cb = stopColor(b.color, base)
      return p <= 0 || ca === cb ? ca : p >= 100 ? cb : `color-mix(in oklab, ${cb} ${p}%, ${ca})`
    }
  }
  return stopColor(s[s.length - 1].color, base)
}

/** 부드럽게 섞기 시작하는 남은 양(%). 주의 기준이 이보다 높으면 주의 기준 바로 위에서 시작한다. */
export const SMOOTH_START = 50

export function barColor(left: number, base: string, o: BarColorOptions): string {
  if (!o.on) return base
  // 사용자가 정한(또는 기본) 색 점 그라데이션. 예전 방식(step·smooth)은 테스트와 호환을 위해 stops 없이 부를 때만.
  if (o.stops !== undefined) return gradientColor(left, base, o.stops, o.mode)
  const warn = Math.max(0, o.warn), crit = Math.max(0, Math.min(warn, o.crit))
  if (left <= crit) return 'var(--danger)'
  if (o.mode !== 'smooth') return left <= warn ? 'var(--warn)' : base
  const top = Math.max(SMOOTH_START, warn + 1)
  if (left >= top) return base
  const mix = (a: string, b: string, t: number) => {
    const p = Math.round(Math.max(0, Math.min(1, t)) * 100)
    return p <= 0 ? b : p >= 100 ? a : `color-mix(in oklab, ${a} ${p}%, ${b})`
  }
  if (left >= warn) return mix('var(--warn)', base, (top - left) / (top - warn))
  return mix('var(--danger)', 'var(--warn)', (warn - left) / Math.max(1, warn - crit))
}

/** 카드 경고 배경의 정도(0~1). 0이면 칠하지 않는다. */
export function heatOf(lowestLeft: number, warn: number, crit: number, paceWarn = false): number {
  const top = Math.max(SMOOTH_START, warn + 1), c = Math.max(0, Math.min(warn, crit))
  const h = lowestLeft >= top ? 0 : Math.min(1, (top - lowestLeft) / Math.max(1, top - c))
  return Math.max(h, paceWarn ? 0.18 : 0)
}

/**
 * 계정 설정의 평소 색을 CSS 색으로. 서비스 색이면 undefined(막대 색 스타일이 그대로 적용).
 * 직접 고른 색은 var(--own, …)로 감싸 막대 색 스타일(오로라 등)이 덮어쓰지 않게 한다(그 스타일은 style에 var(--가 없을 때만 적용).
 */
export function ownColor(setting?: string): string | undefined {
  if (setting === 'green') return 'var(--own,var(--good))'
  if (setting && /^#[\da-f]{6}$/i.test(setting)) return `var(--own,${setting})`
  return undefined
}
