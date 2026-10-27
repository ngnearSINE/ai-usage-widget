/**
 * 그래프 색. 평소에는 서비스의 '평소 색'(서비스 색·초록·직접 고른 색), 남은 양이 줄면 경고색.
 * - step: 주의 기준 아래에서 주황, 위험 기준 아래에서 빨강으로 한 번에 바뀐다.
 * - smooth: 50% 이상은 평소 색, 50%→주의 기준은 평소 색→주황, 주의→위험 기준은 주황→빨강으로 섞는다.
 * 돌려주는 값은 CSS 색(var·color-mix 포함)이라 style 속성으로 써야 한다.
 */
export type ColorMode = 'step' | 'smooth'
export interface BarColorOptions { on: boolean; mode?: ColorMode; warn: number; crit: number }

/** 부드럽게 섞기 시작하는 남은 양(%). 주의 기준이 이보다 높으면 주의 기준 바로 위에서 시작한다. */
export const SMOOTH_START = 50

export function barColor(left: number, base: string, o: BarColorOptions): string {
  if (!o.on) return base
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
