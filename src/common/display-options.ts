import type { WidgetConfig } from './types.js'

/**
 * 서비스별 '보여 줄 정보'. 서비스마다 따로 정한 값이 없으면 전체 값을 쓴다.
 * 전체 값을 바꾸면(표의 '모든 서비스' 행) 그 항목의 서비스별 값은 지워 모두 같아진다.
 */
export type DisplayKey = 'showUsed' | 'showPace' | 'showReset'
export type DisplayOptions = Record<DisplayKey, boolean>
export const DISPLAY_KEYS: Array<[DisplayKey, string, string]> = [
  ['showUsed', '쓴 양으로', '끄면 남은 양으로 보여요'],
  ['showPace', '페이스 눈금', '고르게 썼다면 지금 남아 있어야 할 위치'],
  ['showReset', '리셋 시간', '리셋까지 남은 시간'],
]

export function globalDisplay(c: WidgetConfig): DisplayOptions {
  return { showUsed: !!c.showUsedPercent, showPace: c.showPace !== false, showReset: c.showResetTime !== false }
}
export function displayOf(c: WidgetConfig, id: string): DisplayOptions {
  return { ...globalDisplay(c), ...(c.displayByAccount?.[id] || {}) }
}
const GLOBAL_KEY: Record<DisplayKey, 'showUsedPercent' | 'showPace' | 'showResetTime'> = { showUsed: 'showUsedPercent', showPace: 'showPace', showReset: 'showResetTime' }

/** 한 서비스의 값을 바꾼다. 전체 값과 같아지면 서비스별 값을 지운다. */
export function setDisplay(c: WidgetConfig, id: string, key: DisplayKey, value: boolean): Partial<WidgetConfig> {
  const all = { ...(c.displayByAccount || {}) }, mine = { ...(all[id] || {}) }
  if (globalDisplay(c)[key] === value) delete mine[key]; else mine[key] = value
  if (Object.keys(mine).length) all[id] = mine; else delete all[id]
  return { displayByAccount: all }
}
/** 모든 서비스의 값을 한 번에 바꾼다(그 항목의 서비스별 값은 지운다). */
export function setDisplayAll(c: WidgetConfig, key: DisplayKey, value: boolean): Partial<WidgetConfig> {
  const all: NonNullable<WidgetConfig['displayByAccount']> = {}
  for (const [id, v] of Object.entries(c.displayByAccount || {})) { const rest = { ...v }; delete rest[key]; if (Object.keys(rest).length) all[id] = rest }
  return { [GLOBAL_KEY[key]]: value, displayByAccount: all }
}
/** 표의 '모든 서비스' 칸: 모두 켬·모두 끔·일부. */
export function displaySummary(c: WidgetConfig, ids: string[], key: DisplayKey): 'on' | 'off' | 'mixed' {
  const vals = ids.map(id => displayOf(c, id)[key])
  return vals.every(Boolean) ? 'on' : vals.some(Boolean) ? 'mixed' : 'off'
}
