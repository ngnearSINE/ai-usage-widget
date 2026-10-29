import type { WidgetConfig } from './types.js'

/**
 * 화면에서 온 설정 변경을 저장 전에 거른다. 모르는 키와 형식이 틀린 값은 버려서
 * 설정 파일이 깨지거나(숫자 자리에 문자열 등) 엉뚱한 값이 저장되지 않게 한다.
 */
type Rule = (v: unknown) => unknown
const SKIP = Symbol('skip')
const bool: Rule = v => typeof v === 'boolean' ? v : SKIP
const num = (min: number, max: number, int = true): Rule => v => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, int ? Math.round(v) : v)) : SKIP
const oneOf = <T extends string>(...values: T[]): Rule => v => values.includes(v as T) ? v : SKIP
const rect = (v: unknown) => {
  const r = v as Record<string, unknown> | null
  return r && ['x', 'y', 'width', 'height'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k])) ? { x: Math.round(r.x as number), y: Math.round(r.y as number), width: Math.round(r.width as number), height: Math.round(r.height as number) } : undefined
}
const strings = (max: number): Rule => v => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length <= 200).slice(0, max) : SKIP

const RULES: Partial<Record<keyof WidgetConfig, Rule>> = {
  theme: oneOf('1a', '1b', '1c', '1d'),
  iconStyle: oneOf('color', 'monochrome'),
  alignment: oneOf('left', 'right'),
  offsetPx: num(-10000, 10000),
  verticalOffsetPx: num(-40, 40),
  refreshIntervalSec: num(15, 3600),
  showWeeklyLimit: bool, colorByUsage: bool, showUsedPercent: bool, alwaysOnTop: bool, showCardBackground: bool,
  openAtLogin: bool, doubleClickToOpenPopup: bool, hideDisconnected: bool, webEnabled: bool, webRemote: bool, showResetTime: bool,
  showServiceName: bool, useAcrylic: bool, showPace: bool, sortLowFirst: bool, lockCards: bool, hideHeader: bool, snapEdges: bool, notifyEnabled: bool, notifyLow: bool,
  notifyPace: bool, notifyReset: bool, notifyUnused: bool, trayShowNumber: bool, clickThrough: bool, rememberPerMonitor: bool,
  placementMode: oneOf('docked', 'floating'),
  colorMode: oneOf('step', 'smooth'),
  barStops: v => Array.isArray(v) && v.length >= 2 && v.length <= 8 && v.every(x => x && typeof x.at === 'number' && Number.isFinite(x.at) && typeof x.color === 'string' && /^(brand|warn|danger|#[0-9a-f]{6})$/i.test(x.color))
    ? v.map(x => ({ at: Math.max(0, Math.min(100, Math.round(x.at))), color: String(x.color) })) : v === null ? undefined : SKIP,
  autoUpdate: bool,
  updateHour: num(0, 23),
  warnTint: bool,
  popupBounds: v => rect(v) ?? SKIP,
  warnTintLevel: oneOf('soft', 'medium', 'strong'),
  warnTintOrigin: oneOf('edge', 'center', 'side', 'corners', 'corner'),
  warnTintStrength: num(0, 100),
  warnTintSpread: num(0, 100),
  warnTintSide: oneOf('top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'),
  notifyQuiet: v => {
    const o = v as Record<string, unknown> | null, hm = (s: unknown) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
    return o && typeof o.enabled === 'boolean' && hm(o.start) && hm(o.end) ? { enabled: o.enabled, start: o.start, end: o.end } : SKIP
  },
  displayByAccount: v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return SKIP
    const out: Record<string, Record<string, boolean>> = {}
    for (const [id, o] of Object.entries(v as Record<string, any>)) {
      if (!o || typeof o !== 'object') continue
      const clean: Record<string, boolean> = {}
      for (const k of ['showUsed', 'showPace', 'showReset']) if (typeof o[k] === 'boolean') clean[k] = o[k]
      if (Object.keys(clean).length) out[id.slice(0, 200)] = clean
    }
    return out
  },
  appearance: oneOf('dark', 'light', 'system'),
  barStyle: oneOf('silk', 'aurora', 'neon', 'segments', 'mono', 'spectrum'),
  motion: oneOf('off', 'subtle', 'expressive'),
  accentColor: v => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v : SKIP,
  webPort: num(1024, 65535),
  backgroundColor: v => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v : v === '' || v === null ? undefined : SKIP, // '' = 고르지 않음(테마 바탕)
  fontScale: num(80, 150), // 스케일(창 전체 확대·축소, %)
  cardGap: num(4, 16),
  opacity: num(0, 100),
  design: oneOf('rich', 'numeral', 'bars', 'rings', 'timeline', 'battery'),
  warnPercent: num(5, 50),
  critPercent: num(0, 50),
  notifyMuted: strings(500),
  windowBounds: v => rect(v) ?? SKIP,
  valueSource: v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return SKIP
    const out: Record<string, 'weekly' | '5h' | 'tight'> = {}
    for (const [k, s] of Object.entries(v)) if (['weekly', '5h', 'tight'].includes(s as string)) out[k] = s as 'weekly' | '5h' | 'tight'
    return out
  },
  shortcuts: v => {
    if (!v || typeof v !== 'object') return SKIP
    const out: Record<string, string> = {}
    for (const k of ['toggle', 'lock', 'cycle']) {
      const s = (v as Record<string, unknown>)[k]
      if (typeof s === 'string' && s.length <= 40) out[k] = s
    }
    return out
  },
  layoutsByMonitor: v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return SKIP
    const out: NonNullable<WidgetConfig['layoutsByMonitor']> = {}
    for (const [k, l] of Object.entries(v as Record<string, any>)) {
      if (!l || typeof l !== 'object') continue
      const design = RULES.design!(l.design)
      out[k] = { ...(rect(l.windowBounds) ? { windowBounds: rect(l.windowBounds) } : {}), ...(design !== SKIP ? { design: design as WidgetConfig['design'] } : {}) }
    }
    return out
  },
}

export function sanitizeConfigPatch(patch: unknown): Partial<WidgetConfig> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    const rule = RULES[k as keyof WidgetConfig]
    if (!rule) continue
    const clean = rule(v)
    if (clean !== SKIP) out[k] = clean
  }
  return out as Partial<WidgetConfig>
}
