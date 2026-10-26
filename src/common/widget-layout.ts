import type { AccountConfig, AccountUsage, WidgetConfig } from './types.js'

export const DEFAULT_WINDOW_SIZE = { width: 620, height: 540 }
/** 카드 하나 + 안쪽 여백(6px×2). 서비스가 하나뿐이어도 이 크기까지 줄일 수 있다. */
export const CARD_MIN = { width: 160, height: 56 }
export const MIN_WINDOW_SIZE = { width: CARD_MIN.width + 12, height: CARD_MIN.height + 12 }
/** 이 너비·높이보다 작으면 제목줄을 숨기고 마우스를 위쪽 가장자리에 올릴 때만 겹쳐 보인다(dashboard.css와 같은 값). */
export const HEADER_HIDE = { width: 300, height: 110 }
const HEADER_H = 36

/** 너비가 width일 때 카드 n개가 모두 들어가는 최소 창 높이. 남는 높이가 제목줄 숨김 기준보다 작으면 제목줄을 빼고 잰다. */
export function minWindowHeight(width: number, n: number, gap = 6) {
  const cols = Math.max(1, Math.min(Math.max(1, n), Math.floor((width - 12 + gap) / (CARD_MIN.width + gap))))
  const rows = Math.ceil(Math.max(1, n) / cols)
  const base = rows * CARD_MIN.height + (rows - 1) * gap + 12
  return width >= HEADER_HIDE.width && base + HEADER_H >= HEADER_HIDE.height ? base + HEADER_H : base
}
export interface Rect { x: number; y: number; width: number; height: number }

export function fitWindow(rect: Rect, area: Rect): Rect {
  const width = Math.min(area.width, Math.max(MIN_WINDOW_SIZE.width, Number.isFinite(rect.width) ? rect.width : DEFAULT_WINDOW_SIZE.width))
  const height = Math.min(area.height, Math.max(MIN_WINDOW_SIZE.height, Number.isFinite(rect.height) ? rect.height : DEFAULT_WINDOW_SIZE.height))
  const x = Number.isFinite(rect.x) ? rect.x : area.x + (area.width - width) / 2
  const y = Number.isFinite(rect.y) ? rect.y : area.y + (area.height - height) / 2
  return { x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))), width: Math.round(width), height: Math.round(height) }
}

export function isDockTarget(point: { x: number; y: number }, bounds: Rect, workArea: Rect): boolean {
  // 하단 작업표시줄과 자동 숨김 작업표시줄만 드롭 대상으로 삼는다.
  if (workArea.y > bounds.y || workArea.x > bounds.x || workArea.width < bounds.width) return false
  return point.x >= bounds.x && point.x < bounds.x + bounds.width
    && point.y >= Math.min(workArea.y + workArea.height - 12, bounds.y + bounds.height - 20)
    && point.y < bounds.y + bounds.height
}

/** 화면에 보일 계정. docked면 '작업표시줄에서만 숨김' 계정도 뺀다. */
export function visibleUsages(usages: AccountUsage[], accounts: AccountConfig[], config: WidgetConfig, docked = false): AccountUsage[] {
  const byId = new Map(usages.map(u => [u.id, u]))
  return accounts.filter(a => a.enabled && !a.hidden && !(docked && a.hiddenInDock)).flatMap(a => {
    const u = byId.get(a.id)
    if (!u || (config.hideDisconnected && !['ready', 'stale'].includes(u.status))) return []
    return [u]
  })
}

export function moveAccountBefore(accounts: AccountConfig[], id: string, beforeId: string | null): AccountConfig[] {
  const moving = accounts.find(a => a.id === id)
  if (!moving || id === beforeId || (beforeId !== null && !accounts.some(a => a.id === beforeId))) return accounts
  const next = accounts.filter(a => a.id !== id)
  const index = beforeId === null ? next.length : next.findIndex(a => a.id === beforeId)
  next.splice(index, 0, moving)
  return next
}

export function retainedUsage(current: AccountUsage, previous?: AccountUsage): AccountUsage {
  if ((current.status === 'error' || current.status === 'unauthenticated') && previous && ['ready', 'stale'].includes(previous.status)) {
    return { ...previous, status: 'stale', errorMessage: current.errorMessage }
  }
  return current
}

export type CardDensity = 'rich' | 'medium' | 'compact' | 'minimal'
export function cardLayout(width: number, height: number, count: number, gap: number, scale = 1) {
  if (count < 1) return { columns: 1, rows: 1, density: 'rich' as CardDensity, capacity: 1 }
  const levels: Array<{density: CardDensity; width: number; height: number}> = [
    { density:'rich',width:225*scale,height:207*scale },
    { density:'medium',width:180*scale,height:138*scale },
    { density:'compact',width:125*scale,height:68*scale },
    { density:'minimal',width:110*scale,height:44*scale },
  ]
  for (const level of levels) {
    let best: {columns:number; rows:number; density:CardDensity; capacity:number; score:number} | undefined
    for(let cols=1;cols<=Math.min(count,12);cols++) {
      const rows=Math.ceil(count/cols)
      const cw=(width-gap*(cols-1))/cols, ch=(height-gap*(rows-1))/rows
      if(cw<level.width || ch<level.height) continue
      const score=Math.abs(cw/ch-1.45)+(rows*cols-count)*.4
      if(!best || score<best.score) best={columns:cols,rows,density:level.density,capacity:count,score}
    }
    if(best) return best
  }
  // 설정 가능한 서비스 수가 물리적인 공간을 넘으면 페이지로 나눠 스크롤과 잘림을 피한다.
  const columns=Math.max(1,Math.floor((width+gap)/(110*scale+gap)))
  const rows=Math.max(1,Math.floor((height+gap)/(44*scale+gap)))
  return {columns,rows,density:'minimal' as CardDensity,capacity:columns*rows}
}
