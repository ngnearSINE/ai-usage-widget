import type { AccountConfig, AccountUsage, WidgetConfig } from './types.js'

export const DEFAULT_WINDOW_SIZE = { width: 620, height: 540 }
/** 카드 하나 + 안쪽 여백(6px×2). 서비스가 하나뿐이어도 이 크기까지 줄일 수 있다. */
export const CARD_MIN = { width: 160, height: 56 }
export const MIN_WINDOW_SIZE = { width: CARD_MIN.width + 12, height: CARD_MIN.height + 12 }
/** 이 너비·높이보다 작으면 제목줄을 숨기고 마우스를 위쪽 가장자리에 올릴 때만 겹쳐 보인다(dashboard.css와 같은 값). */
export const HEADER_HIDE = { width: 300, height: 110 }
const HEADER_H = 36

/** 너비가 width일 때 카드 n개가 모두 들어가는 최소 창 높이. 남는 높이가 제목줄 숨김 기준보다 작거나 제목줄을 항상 숨기면 제목줄을 빼고 잰다. */
export function minWindowHeight(width: number, n: number, gap = 6, headerHidden = false) {
  const cols = Math.max(1, Math.min(Math.max(1, n), Math.floor((width - 12 + gap) / (CARD_MIN.width + gap))))
  const rows = Math.ceil(Math.max(1, n) / cols)
  const base = rows * CARD_MIN.height + (rows - 1) * gap + 12
  return !headerHidden && width >= HEADER_HIDE.width && base + HEADER_H >= HEADER_HIDE.height ? base + HEADER_H : base
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

/** 이 거리(px) 안으로 가장자리에 다가가면 붙는다. 더 끌어 이 거리를 넘으면 바로 떨어진다(붙는 기준과 떨어지는 기준이 같아 떨리지 않는다). */
export const SNAP_PX = 12

/**
 * 끄는 창을 모니터 작업 영역(작업 표시줄 제외)의 가장자리에 붙인다. 가로·세로를 따로 보므로 둘 다 붙으면 모서리에 붙는다.
 * 각 가장자리는 창의 같은 쪽 경계와 잰다(위는 창 위쪽, 아래는 창 아래쪽). 아래는 작업 표시줄 바로 위다.
 * 다른 모니터와 맞닿은 경계에는 붙지 않는다(모니터를 건너갈 때 걸리지 않게). 맞닿았는지는 창이 걸친 범위로 본다:
 * 옆 모니터가 낮게 붙어 있으면 그 위쪽 구석은 바깥 경계라 붙는다.
 */
export function snapToEdges(rect: Rect, area: Rect, bounds: Rect, others: Rect[] = [], threshold = SNAP_PX): { x: number; y: number } {
  const overlapsY = (o: Rect) => o.y < rect.y + rect.height && o.y + o.height > rect.y
  const overlapsX = (o: Rect) => o.x < rect.x + rect.width && o.x + o.width > rect.x
  // 작업 영역 가장자리가 모니터 가장자리이고 그 너머에 다른 모니터가 붙어 있으면 안쪽 경계다.
  const inner = {
    left: area.x === bounds.x && others.some(o => o.x + o.width === bounds.x && overlapsY(o)),
    right: area.x + area.width === bounds.x + bounds.width && others.some(o => o.x === bounds.x + bounds.width && overlapsY(o)),
    top: area.y === bounds.y && others.some(o => o.y + o.height === bounds.y && overlapsX(o)),
    bottom: area.y + area.height === bounds.y + bounds.height && others.some(o => o.y === bounds.y + bounds.height && overlapsX(o)),
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= threshold
  let { x, y } = rect
  if (!inner.left && near(rect.x, area.x)) x = area.x
  else if (!inner.right && near(rect.x + rect.width, area.x + area.width)) x = area.x + area.width - rect.width
  if (!inner.top && near(rect.y, area.y)) y = area.y
  else if (!inner.bottom && near(rect.y + rect.height, area.y + area.height)) y = area.y + area.height - rect.height
  return { x, y }
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
    // '연결 안 된 서비스 숨기기'는 한 번도 연결된 적 없는 계정에만. 한 번 연결됐던 계정은 끊겨도 계속 보여 준다.
    if (!u || (config.hideDisconnected && !['ready', 'stale'].includes(u.status) && !u.everConnected)) return []
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

/**
 * 카드에 보여 줄 값: 이번에 받은 값이 있으면 그것, 아직 조회 전이면 기억해 둔 마지막 값을 '확인 중'으로,
 * 둘 다 없으면 처음 상태. 한 번이라도 값을 받은 계정은 everConnected(끊겨도 숨기지 않음).
 */
export function displayUsage(current: AccountUsage | undefined, last: AccountUsage | undefined, initial: AccountUsage): AccountUsage {
  const usage = current || (last ? { ...last, status: 'stale' as const, pending: true } : initial)
  return last ? { ...usage, everConnected: true } : usage
}

export function retainedUsage(current: AccountUsage, previous?: AccountUsage): AccountUsage {
  if ((current.status === 'error' || current.status === 'unauthenticated') && previous && ['ready', 'stale'].includes(previous.status)) {
    return { ...previous, status: 'stale', errorMessage: current.errorMessage }
  }
  // 실측이 잠깐 실패해 어림값(로컬 기록 추정)으로 바뀌면 마지막 실측을 '갱신 지연'으로 유지한다(숫자가 갑자기 튀지 않게).
  if (current.isEstimated && previous && !previous.isEstimated && ['ready', 'stale'].includes(previous.status)) {
    return { ...previous, status: 'stale' }
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
