import { staleTip } from '../../common/stale-notice.js'
import type { AccountUsage, AppState, QuotaInfo, WidgetConfig, HeatSide } from '../../common/types.js'
import { barColor } from '../../common/bar-color.js'
import { initCardGlow } from './card-glow.js'
import { displayOf } from '../../common/display-options.js'
import { visibleUsages } from '../../common/widget-layout.js'
import { chooseLayout, DESIGNS, lowestLeft, serviceModel, severity, SOURCE_LABEL, type DesignId, type ValueSource } from '../../common/usage-model.js'
import { renderAiIcon } from './ai-icons.js'
import { renderCard, viewContext, isOutOfDate, PENDING_TIP } from './usage-views.js'
import { updateMarkup } from '../dom-update.js'

const paths: Record<string, string> = {
  sliders: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8a7 7 0 0 1 11.6-2L20 9M4 15l2.3 3A7 7 0 0 0 18 16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  pin: '<path d="M9 4h6l-1 6 3 3v1H7v-1l3-3z"/><path d="M12 14v6"/>',
  pinFill: '<path d="M9 4h6l-1 6 3 3v1H7v-1l3-3z" fill="currentColor"/><path d="M12 14v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 21.5A2.5 2.5 0 0 1 6.5 19H20"/>',
  expand: '<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>',
  minus: '<path d="M5 12h14"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  dock: '<path d="M4 15V5h16v10M3 19h18M9 11l3 3 3-3M12 7v7"/>',
  arrow: '<path d="m7 17 10-10M7 7h10v10"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  hidden: '<path d="m3 3 18 18M10.6 5.1A14 14 0 0 1 12 5c6.5 0 10 7 10 7a20 20 0 0 1-3.5 4.4M6.3 6.4A22 22 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5-1.1"/>',
  up: '<path d="m6 14 6-6 6 6"/>', down: '<path d="m6 10 6 6 6-6"/>',
  chev: '<path d="m7 10 5 5 5-5"/>',
  menu: '<path d="M5 7h14M5 12h14M5 17h14"/>',
  taskbar: '<rect x="3" y="15" width="18" height="5" rx="1.5"/><path d="M7 17.5h2M11 17.5h2"/><path d="M12 4v7M9 8l3 3 3-3"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m14 6 4 4"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
}
export const icon = (name: string) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`
export const escapeText = (value: string) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const color = (value?: string) => /^#[\da-f]{6}$/i.test(value || '') ? value! : '#a99bff'
const clamp = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
const number = (n: number | undefined, min: number, max: number, fallback: number) => Number.isFinite(n) ? Math.min(max, Math.max(min, n!)) : fallback
let busy = false
let dragId: string | null = null
let previewOrder: string[] | null = null // 카드를 끄는 동안의 임시 순서
let lastState: AppState
let host: HTMLElement
let toastTimer: ReturnType<typeof setTimeout>
let mediaQuery: MediaQueryList | undefined
let layoutObserver: ResizeObserver | undefined
let layoutFrame = 0
let pageIndex = 0
let pageCount = 1
let delegated = false

/** 진한 곳: 예전 값(네 모서리→테두리, 한 모서리→한쪽 왼쪽 위)을 지금 값으로 읽는다. */
export function heatPlacement(config: WidgetConfig): { origin: 'edge' | 'center' | 'side'; side: HeatSide } {
  const o = config.warnTintOrigin
  if (o === 'corner') return { origin: 'side', side: config.warnTintSide || 'top-left' }
  return { origin: o === 'center' || o === 'side' ? o : 'edge', side: config.warnTintSide || 'top-left' }
}

export function applyAppearance(config: WidgetConfig) {
  document.documentElement.dataset.appearance = config.appearance === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : config.appearance || 'dark'
  document.documentElement.dataset.bar = config.barStyle || 'silk'
  document.documentElement.dataset.motion = config.motion || 'subtle'
  document.documentElement.dataset.acrylic = String(config.useAcrylic !== false)
  // 경고 배경: 세기는 0~100 연속값(기본 30 = 예전 100%), 진한 곳은 테두리·가운데·한쪽(8방향)
  const heat = heatPlacement(config)
  document.documentElement.dataset.heatOrigin = heat.origin
  document.documentElement.dataset.heatSide = heat.side
  document.documentElement.style.setProperty('--heat-max', (number(config.warnTintStrength, 0, 100, 30) / 100 * 1.5).toFixed(3))
  // 퍼짐 0~100(기본 30 = 예전 모양): 진한 곳에서 번지는 길이와, 30을 넘으면 카드 전체에 깔리는 옅은 바탕
  const spread = number(config.warnTintSpread, 0, 100, 30)
  document.documentElement.style.setProperty('--heat-reach', (.4 + spread / 50).toFixed(3))
  document.documentElement.style.setProperty('--heat-inner', `${(46 * (1 - spread / 100)).toFixed(1)}%`)
  document.documentElement.style.setProperty('--heat-soft-pct', `${(Math.max(0, spread - 30) / 70 * 35).toFixed(1)}%`)
  document.documentElement.style.setProperty('--accent', color(config.accentColor))
  document.documentElement.style.setProperty('--panel-alpha', String(number(config.opacity, 0, 100, 70) / 100))
  document.documentElement.style.setProperty('--font-scale', String(number(config.fontScale, 85, 130, 100) / 100))
  document.documentElement.style.setProperty('--card-gap', `${number(config.cardGap, 4, 16, 6)}px`)
  if (!mediaQuery) {
    mediaQuery = matchMedia('(prefers-color-scheme: light)')
    mediaQuery.addEventListener('change', () => { if (lastState) applyAppearance(lastState.config) })
  }
}

/* ---------- 작업표시줄 도킹 표시(기존 유지) ---------- */
function miniSummary(u: AccountUsage, config: WidgetConfig) {
  const available = ['ready', 'stale'].includes(u.status)
  const quotas: Array<QuotaInfo | undefined> = [u.isWeeklyOnly ? undefined : u.primaryQuota, u.isWeeklyOnly ? u.primaryQuota : u.weeklyQuota]
  // 모델 전용 주간 한도(Fable 등)를 보기로 둔 계정은 작업표시줄에도 세 번째 줄로 보인다(숨긴 계정은 상태에서 이미 빠져 있다).
  const scoped = u.scopedQuotas || []
  const rows = [...quotas, ...scoped.map(s => s.quota)]
  const warn = Math.max(1, Math.min(60, config.warnPercent ?? 20)), showUsed = displayOf(config, u.id).showUsed
  const colorOpts = { on: config.colorByUsage !== false, mode: config.colorMode, warn, crit: Math.max(0, Math.min(warn, config.critPercent ?? 10)) }
  return `<div class="mini-summary">${renderAiIcon(u.provider, u.name, config.iconStyle, 20)}<div class="mini-quotas ${rows.length > 2 ? 'three' : ''}">${rows.map((q, i) => {
    const value = available && q ? clamp(showUsed ? q.percentUsed : q.percentLeft) : null
    const name = i === 0 ? (u.primaryKind === 'monthly' ? '월간' : '5시간') : i === 1 ? '전체(주간)' : `${scoped[i - 2].label}(주간)`
    const label = `${name} ${showUsed ? '사용한 양' : '남은 양'}`
    // 줄마다 기본 색(--row-base: 서비스 평소 색과 그 흐린 색)에서 경고색으로 바뀐다(CSS에서 줄별로 정함).
    const fill = available && q ? barColor(clamp(q.percentLeft), 'var(--row-base)', colorOpts) : 'var(--row-base)'
    return `<div class="mini-quota ${i === 1 ? 'secondary' : i > 1 ? 'secondary scoped' : ''}" title="${label}: ${value === null ? '정보 없음' : `${value}%`}"><div class="meter"><div class="meter-fill" style="--value:${value ?? 0}%;--fill:${fill}"></div></div><span class="mini-value" aria-label="${label}: ${value === null ? '정보 없음' : `${value}%`}">${value === null ? '—' : `${value}<small>%</small>`}</span></div>`
  }).join('')}</div></div>`
}
export function renderDockedUsage(u: AccountUsage, config: WidgetConfig) {
  return `<div class="docked-service" data-account-id="${escapeText(u.id)}" style="--brand:${u.barColor || color(u.brandColor)}" title="${escapeText(u.pending ? `${u.name}\n${PENDING_TIP}` : isOutOfDate(u) ? `${u.name}\n${staleTip(u, Date.now(), u.status === 'stale')}` : u.name)}">${u.pending ? '<span class="stale-mark dock pending" aria-hidden="true"><i></i><i></i><i></i></span>' : isOutOfDate(u) ? '<span class="stale-mark dock" aria-hidden="true">!</span>' : ''}${miniSummary(u, config)}</div>`
}

/** 트레이·다른 창에서 '디자인 설정'을 열 때. 설정은 별도 설정 창에서 한다. */
export function openDesign() { void window.api.openSettings('design') }

/* ---------- 본체 ---------- */
const designOf = (config: WidgetConfig): DesignId => (DESIGNS.some(d => d[0] === config.design) ? config.design : 'rich') as DesignId
function shownUsages(state: AppState) {
  let list = visibleUsages(state.usages, state.accounts, state.config)
  if (state.focus && list.some(u => u.id === state.focus)) return list.filter(u => u.id === state.focus)
  if (previewOrder) { const at = new Map(previewOrder.map((id, i) => [id, i])); return [...list].sort((a, b) => (at.get(a.id) ?? 999) - (at.get(b.id) ?? 999)) }
  // 여유가 적은 순 정렬은 연결된 서비스끼리만, 연결 안 된 카드는 뒤로.
  return state.config.sortLowFirst
    ? [...list].sort((a, b) => lowestLeft(serviceModel(a)) - lowestLeft(serviceModel(b)))
    : list
}

/* ---------- 카드 순서 끌기 ----------
   카드를 누른 채 6px 넘게 움직이면 시작한다. 끄는 카드는 복제본이 포인터에 붙어 다니고, 원래 카드는 반투명 점선 칸이 되어
   놓으면 들어갈 자리를 보여 준다. 그 칸이 옮겨 갈 때 다른 카드는 미끄러지듯 비켜 준다. 놓으면 복제본이 그 칸으로 들어간다.
   여유 적은 순 정렬이 켜져 있으면 순서를 바꿀 수 없음을 알린다. */
function startCardReorder(card: HTMLElement, down: PointerEvent) {
  const id = card.dataset.card!, startX = down.clientX, startY = down.clientY
  let started = false, grabX = 0, grabY = 0, order: string[] = [], slots: DOMRect[] = []
  let ghost: HTMLElement | null = null, frame: DOMRect, cardW = 0, cardH = 0
  const dash = () => host.querySelector<HTMLElement>('.dashboard')!
  const cardEl = () => host.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)
  const rects = () => new Map([...host.querySelectorAll<HTMLElement>('[data-card]')].map(c => [c.dataset.card!, c.getBoundingClientRect()]))
  const follow = (x: number, y: number) => { if (ghost) ghost.style.transform = `translate(${x - grabX - frame.left}px, ${y - grabY - frame.top}px)` }
  const markSlot = () => cardEl()?.classList.add('drop-slot')
  const relayout = (next: string[]) => {
    const before = rects()
    previewOrder = next
    layoutCards()
    markSlot() // 다시 그리면 클래스가 원래대로 돌아가므로 다시 붙인다
    for (const c of host.querySelectorAll<HTMLElement>('[data-card]')) {
      const a = before.get(c.dataset.card!), b = c.getBoundingClientRect()
      if (!a || (a.left === b.left && a.top === b.top)) continue
      c.style.transition = 'none'; c.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`
      requestAnimationFrame(() => { c.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)'; c.style.transform = '' })
    }
  }
  const move = (e: PointerEvent) => {
    if (!started) {
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 6) return
      if (lastState.config.sortLowFirst) { notify('‘여유가 적은 서비스를 앞으로’가 켜져 있어 순서를 바꿀 수 없어요. 설정 → 표시에서 끌 수 있어요.'); cleanup(); return }
      started = true; dragId = id
      const r = card.getBoundingClientRect(); grabX = startX - r.left; grabY = startY - r.top; cardW = r.width; cardH = r.height
      order = shownUsages(lastState).map(u => u.id)
      // 칸 위치는 시작할 때 고정한다(비켜 가는 애니메이션 도중의 위치로 계산하면 자리가 흔들린다).
      const at = rects(); slots = order.map(x => at.get(x)!).filter(Boolean)
      frame = dash().getBoundingClientRect()
      ghost = card.cloneNode(true) as HTMLElement
      ghost.removeAttribute('data-card'); ghost.removeAttribute('data-tip')
      ghost.classList.add('drag-ghost')
      Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px` })
      dash().appendChild(ghost)
      markSlot()
      document.body.classList.add('reordering')
      window.api.hideTip?.()
      // 카드는 자리를 옮길 때 DOM에서 빠졌다 들어가 포인터 붙잡기가 풀린다. 움직이지 않는 바깥 틀이 붙잡는다.
      try { host.setPointerCapture(e.pointerId) } catch {}
    }
    follow(e.clientX, e.clientY)
    // 들고 있는 카드의 가운데가 있는(없으면 가장 가까운) 칸에 들어간다. 카드를 어디를 잡았든 같은 만큼 끌면 자리가 바뀐다.
    const cx = e.clientX - grabX + cardW / 2, cy = e.clientY - grabY + cardH / 2
    let slot = 0, best = Infinity
    slots.forEach((r, i) => {
      const inside = cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom
      const dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2), d = inside ? -1 : dx * dx + dy * dy
      if (d < best) { best = d; slot = i }
    })
    const next = order.filter(x => x !== id)
    next.splice(Math.min(slot, next.length), 0, id)
    if (next.join('|') !== (previewOrder || order).join('|')) relayout(next)
  }
  const cleanup = () => { host.removeEventListener('pointermove', move); host.removeEventListener('pointerup', up); host.removeEventListener('pointercancel', cancel); document.body.classList.remove('reordering') }
  const finish = async (save: boolean) => {
    cleanup()
    if (!started) return
    const final = save ? previewOrder || order : order
    // 들고 있던 카드를 들어갈 칸으로 내려놓는 짧은 움직임
    const slotRect = cardEl()?.getBoundingClientRect()
    if (ghost && slotRect && save) {
      ghost.style.transition = 'transform .16s cubic-bezier(.2,.8,.2,1), box-shadow .16s'
      ghost.style.transform = `translate(${slotRect.left - frame.left}px, ${slotRect.top - frame.top}px)`
      ghost.classList.add('landing')
      await new Promise(r => setTimeout(r, 170))
    }
    ghost?.remove(); ghost = null
    previewOrder = null; dragId = null
    if (save && final.join('|') !== order.join('|')) {
      const i = final.indexOf(id), beforeId = final[i + 1] ?? null
      try { const next = await window.api.moveAccount(id, beforeId); renderDashboard(host, next, true); notify('순서를 저장했어요.'); return }
      catch { notify('순서를 저장하지 못했어요.') }
    }
    renderDashboard(host, lastState, true)
  }
  const up = () => { void finish(true) }
  const cancel = () => { void finish(false) }
  host.addEventListener('pointermove', move)
  host.addEventListener('pointerup', up)
  host.addEventListener('pointercancel', cancel)
}

export function renderDashboard(container: HTMLElement, state: AppState, force = false) {
  host = container
  lastState = state
  applyAppearance(state.config)
  if (!force && (busy || dragId)) return
  const design = designOf(state.config)
  updateMarkup(container, `<div class="dashboard ${state.focus ? 'focus-mode' : ''}">
    <div class="header-hot" aria-hidden="true"></div>
    <header class="dashboard-header"><div class="window-handle" data-window-drag title="${state.dockSupported === false ? '끌어서 창 이동' : '끌어서 창 이동 · 아래로 끌면 도킹'}"><span class="app-symbol" aria-hidden="true"><i></i><i></i><i></i></span><span class="app-title">AI 사용량</span><span class="header-status" data-status></span></div>
      <span class="header-clock num" data-clock aria-hidden="true"></span>
      ${updatePill(state)}
      <button class="tool pin ${state.config.alwaysOnTop !== false ? 'on' : ''}" data-action="pin" aria-pressed="${state.config.alwaysOnTop !== false}" title="${state.config.alwaysOnTop !== false ? '항상 위 켜짐 · 눌러서 끄기' : '항상 위 꺼짐 · 눌러서 켜기'}" aria-label="항상 위에 표시">${icon(state.config.alwaysOnTop !== false ? 'pinFill' : 'pin')}</button>
      <button class="tool ${state.isRefreshing ? 'is-refreshing' : ''}" data-action="refresh" aria-label="사용량 새로고침" title="새로고침" ${state.isRefreshing ? 'disabled' : ''}>${icon('refresh')}</button>
      <button class="tool" data-settings="last" title="설정" aria-label="설정 열기">${icon('sliders')}</button>
      <button class="tool" data-view-menu aria-haspopup="menu" title="메뉴 · 지금 디자인: ${DESIGNS.find(d => d[0] === design)![1]}" aria-label="메뉴">${icon('menu')}</button>
      <button class="tool window-hide" data-action="hide" title="트레이로 숨기기" aria-label="트레이로 숨기기">${icon('minus')}</button></header>
    <main class="dashboard-content" data-grid-host data-keep><div class="service-grid"></div></main>
    <div class="toast" role="status" aria-live="polite"></div>
    ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => `<div class="resize-handle resize-${edge}" data-resize="${edge}" aria-hidden="true"></div>`).join('')}
  </div>`)
  bindEvents(container, state)
  layoutObserver?.disconnect()
  layoutObserver = new ResizeObserver(() => { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(layoutCards) })
  const gridHost = container.querySelector('[data-grid-host]')
  if (gridHost) layoutObserver.observe(gridHost)
  layoutCards()
}

/** 격자 크기를 재고 배치를 고른 뒤 카드를 그린다. 창 크기가 바뀔 때마다 다시 호출된다. */
function layoutCards() {
  const gridHost = host?.querySelector<HTMLElement>('[data-grid-host]')
  if (!gridHost || !lastState) return
  const state = lastState, design = designOf(state.config), x = viewContext(state.config, state.history)
  const all = shownUsages(state)
  const gap = number(state.config.cardGap, 4, 16, 6)
  // clientWidth/Height에는 안쪽 여백이 포함되므로 빼고 계산한다.
  const pad = parseFloat(getComputedStyle(gridHost).paddingLeft) || 0
  const W = gridHost.clientWidth - pad * 2, H = gridHost.clientHeight - pad * 2
  const anyLoading = state.isRefreshing || state.usages.some(u => u.status === 'loading')
  const hidden = state.accounts.filter(a => a.enabled).length - visibleUsages(state.usages, state.accounts, state.config).length
  let pages = 1, gridHtml: string
  if (!all.length) {
    gridHtml = `<div class="service-grid empty"><div class="empty-state">${icon(anyLoading ? 'refresh' : 'grid')}<h2>${anyLoading ? '서비스를 확인하고 있어요' : '표시할 서비스가 없어요'}</h2>${W > 260 && H > 140 ? `<p>${anyLoading ? '기존 로그인으로 사용량을 가져옵니다.' : '연결 상태와 숨김 설정을 서비스 관리에서 확인해 주세요.'}</p>` : ''}<button class="secondary-button" data-settings="services">서비스 관리</button></div></div>`
  } else {
    const L = chooseLayout(W, H, all.length, design, gap)
    pages = Math.ceil(all.length / L.per)
    pageCount = pages
    pageIndex = Math.min(pageIndex, pages - 1)
    const list = all.slice(pageIndex * L.per, pageIndex * L.per + L.per)
    const spare = L.rows * L.cols - list.length
    // 빈 격자 칸은 마지막 카드를 넓혀 채우고, 넓어진 카드는 자기 크기로 다시 판정한다.
    gridHtml = `<div class="service-grid" style="grid-template-columns:repeat(${L.cols},minmax(0,1fr));grid-template-rows:repeat(${L.rows},minmax(0,1fr))">${list.map((u, i) => {
      const last = spare && i === list.length - 1, w = last ? L.cw * (spare + 1) + gap * spare : L.cw
      return renderCard(u, design, x, { w, h: L.ch }, last ? `grid-column:span ${spare + 1};--index:${i};` : `--index:${i};`)
    }).join('')}</div>`
  }
  updateMarkup(gridHost, gridHtml)
  // 제목줄 상태: 연결 수·마지막 확인·주의 수, 페이지가 나뉘면 페이지 넘김.
  const connected = state.usages.filter(u => ['ready', 'stale'].includes(u.status)).length
  const warnN = all.filter(u => severity(serviceModel(u), x.warn, x.crit, x.per ? x.per(u.id).showPace : x.showPace)).length
  const hm = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  const last = state.lastRefreshedAt ? Date.parse(state.lastRefreshedAt) : NaN
  // 마지막·다음 갱신 시각은 제목줄에 쓰지 않고 새로고침 단추의 설명으로만 보여 준다.
  const refreshBtn = host.querySelector<HTMLElement>('[data-action="refresh"]')
  if (refreshBtn) refreshBtn.title = Number.isFinite(last) ? `새로고침 · 마지막 갱신 ${hm(last)} · 다음 ${hm(last + (state.config.refreshIntervalSec || 60) * 1000)}` : '새로고침'
  const status = host.querySelector<HTMLElement>('[data-status]')
  const lock = state.config.clickThrough ? `<span class="lock-badge" title="클릭 통과 잠금 중">${icon('lock')}잠김${state.config.shortcuts?.lock ? ` · ${escapeText(state.config.shortcuts.lock)}로 풀기` : ''}</span> · ` : ''
  const focusName = state.focus ? state.accounts.find(a => a.id === state.focus)?.name : ''
  if (status && focusName) { status.innerHTML = `<button class="focus-chip" data-focus-off title="집중 모드 끄기 (Esc · 카드 더블클릭)">집중: ${escapeText(focusName)} <span aria-hidden="true">✕</span></button>`; tickClock(true); return }
  if (status) status.innerHTML = lock + (pages > 1
    ? `<button class="pager" data-page="-1" aria-label="이전 서비스">‹</button><span>${pageIndex + 1}/${pages}</span><button class="pager" data-page="1" aria-label="다음 서비스">›</button>${warnN ? ` · <span class="w">${warnN}개 주의</span>` : ''}`
    : `<b>${anyLoading ? '확인 중' : `${connected}개 연결`}</b>${state.preview ? '<span data-pv-fallback hidden> · 미리보기</span>' : ''}${warnN ? ` · <span class="w">${warnN}개 주의</span>` : ''}${hidden > 0 ? ` · <button class="status-link" data-settings="services">${hidden}개 숨김</button>` : ''}`)
  tickClock(true)
}

/**
 * 제목줄 가운데 현재 시각. 왼쪽 상태 문구나 오른쪽 단추와 겹치면 숨긴다.
 * force면 자리를 다시 재고, 아니면(1초마다) 분이 바뀔 때만 글자를 바꾼다.
 */
function tickClock(force = false) {
  const clock = host?.querySelector<HTMLElement>('[data-clock]')
  if (!clock) return
  // 미리보기 앱이면 시각 뒤에 '(미리보기)'를 붙인다. 시계를 숨길 때는 왼쪽 상태 문구에 대신 보인다.
  const now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) + (lastState?.preview ? ' (미리보기)' : '')
  if (!force) { if (clock.dataset.on === '1' && clock.textContent !== now) clock.textContent = now; return }
  clock.textContent = now; clock.dataset.on = '1'
  const header = clock.parentElement!, r = clock.getBoundingClientRect()
  // 끌기 손잡이는 제목줄 폭을 다 차지하므로 글자(제목·상태)의 실제 끝으로 잰다.
  const left = header.querySelector('.app-title')?.getBoundingClientRect(), right = header.querySelector('.tool, .update-pill')?.getBoundingClientRect()
  const status = header.querySelector('[data-status]')
  // 상태 칸은 늘어나 있을 수 있어 글자가 실제로 차지한 끝을 잰다.
  let statusRight = left?.right ?? 0
  if (status?.textContent) { const range = document.createRange(); range.selectNodeContents(status); statusRight = Math.max(statusRight, Math.min(range.getBoundingClientRect().right, status.getBoundingClientRect().right)) }
  if (r.left < statusRight + 12 || (right && r.right > right.left - 12)) {
    clock.textContent = ''; clock.dataset.on = ''
    header.querySelector<HTMLElement>('[data-pv-fallback]')?.removeAttribute('hidden')
  }
}

/* ---------- 메뉴 ---------- */
/** 자동 업데이트 설치 시각 표기와 고르기. */
export const hourLabel = (h: number) => `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}시`
export function updateHourSelect(state: AppState) {
  const cur = state.config.updateHour ?? 3
  return `<select class="text-input short hour-select" data-update-hour aria-label="자동 업데이트 설치 시각" ${state.config.autoUpdate === false ? 'disabled' : ''}>${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === cur ? 'selected' : ''}>${hourLabel(h)}</option>`).join('')}</select>`
}

/** 새 버전을 받아 두었으면 제목줄에 짧은 '업데이트' 단추(마우스를 올리면 전체 안내). */
export function updatePill(state: AppState) {
  const u = state.update
  if (u?.status !== 'ready') return ''
  return `<button class="update-pill" data-update-install data-tip="새 버전 ${escapeText(u.version || '')} 설치하고 다시 시작" aria-label="새 버전 ${escapeText(u.version || '')} 설치하고 다시 시작">업데이트</button>`
}

let menuEl: HTMLElement | null = null
function closeMenu() { menuEl?.remove(); menuEl = null }
function openMenu(anchor: HTMLElement, items: Array<{ key: string; label: string; hint?: string; on?: boolean; run: () => void } | '-'>) {
  closeMenu()
  const dash = host.querySelector<HTMLElement>('.dashboard')!
  menuEl = document.createElement('div')
  menuEl.className = 'menu'
  menuEl.setAttribute('role', 'menu')
  menuEl.innerHTML = items.map(it => it === '-' ? '<div class="sep"></div>' : `<button role="menuitemradio" aria-checked="${!!it.on}" data-key="${it.key}"><span class="check">${it.on ? icon('check') : ''}</span>${it.label}${it.hint ? `<small>${it.hint}</small>` : ''}</button>`).join('')
  dash.appendChild(menuEl)
  const r = anchor.getBoundingClientRect(), d = dash.getBoundingClientRect()
  menuEl.style.left = `${Math.max(6, Math.min(d.width - menuEl.offsetWidth - 6, r.left - d.left))}px`
  menuEl.style.top = `${Math.min(d.height - menuEl.offsetHeight - 6, r.bottom - d.top + 4)}px`
  menuEl.onclick = e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-key]'); if (!b) return
    const it = items.find(i => i !== '-' && i.key === b.dataset.key) as { run: () => void } | undefined
    closeMenu(); it?.run()
  }
  menuEl.querySelector<HTMLElement>('[aria-checked="true"],button')?.focus({ preventScroll: true })
}

/** CLI·앱 열기(못 찾으면 안내). */
async function openTool(kind: 'cli' | 'app', id: string) {
  const ok = await window.api.openServiceTool(kind, id).catch(() => false)
  const name = lastState?.accounts.find(a => a.id === id)?.name || '이 서비스'
  notify(ok ? `${name} ${kind === 'cli' ? 'CLI를 터미널에서' : '앱을'} 여는 중이에요.` : `이 PC에서 ${name} ${kind === 'cli' ? 'CLI' : '앱'}을 찾지 못했어요.`)
}

function notify(message: string) {
  const toast = host.querySelector<HTMLElement>('.toast')
  if (!toast) return
  clearTimeout(toastTimer); toast.textContent = message; toast.classList.add('visible')
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2400)
}
async function update(patch: Partial<WidgetConfig>) {
  try { const next = await window.api.updateConfig(patch); renderDashboard(host, next, true) }
  catch { notify('설정을 저장하지 못했어요. 다시 시도해 주세요.') }
}

/** 카드·메뉴처럼 배치 때마다 다시 그려지는 요소는 컨테이너에 한 번만 위임해 처리한다. */
function bindDelegated(container: HTMLElement) {
  if (delegated) return
  delegated = true
  initCardGlow(container)
  setInterval(() => tickClock(), 1000)
  container.addEventListener('click', e => {
    const t = e.target as HTMLElement
    const view = t.closest<HTMLElement>('[data-view-menu]')
    if (view) {
      e.stopPropagation()
      const current = designOf(lastState.config)
      openMenu(view, [...DESIGNS.map(([key, label, hint], i) => ({ key, label, hint: `${hint} · Ctrl+${i + 1}`, on: current === key, run: () => { void update({ design: key }) } })), '-',
        { key: 'settings', label: '설정', run: () => { void window.api.openSettings('last') } },
        { key: 'about', label: '정보·업데이트', run: () => { void window.api.openAbout?.() } },
        { key: 'hide', label: '트레이로 숨기기', run: () => { void window.api.hideWidget() } },
        '-',
        { key: 'quit', label: '종료', run: () => { void window.api.quitApp() } }])
      return
    }
    const src = t.closest<HTMLElement>('[data-src]')
    if (src) {
      e.stopPropagation()
      const id = src.dataset.src!, now = lastState.config.valueSource?.[id] || 'weekly'
      const monthly = lastState.usages.find(u => u.id === id)?.primaryKind === 'monthly'
      openMenu(src, [...(Object.keys(SOURCE_LABEL) as ValueSource[]).map(k => ({ key: k, label: k === '5h' && monthly ? '월간' : SOURCE_LABEL[k], on: now === k, run: () => { void update({ valueSource: { ...lastState.config.valueSource, [id]: k } }) } })), '-',
        { key: 'all', label: '모든 카드에 같은 기준 적용', run: () => { const all: Record<string, ValueSource> = {}; for (const u of lastState.usages) all[u.id] = now; void update({ valueSource: all }) } }])
      return
    }
    if (t.closest('[data-focus-off]')) { void window.api.setFocus(null); return }
    if (t.closest('[data-update-install]')) { void window.api.installUpdate(); return }
    const pg = t.closest<HTMLElement>('[data-page]')
    if (pg) { pageIndex = (pageIndex + Number(pg.dataset.page) + pageCount) % pageCount; layoutCards(); return }
    if (menuEl && !t.closest('.menu')) closeMenu()
  })
  container.addEventListener('keydown', e => { if (e.key === 'Escape' && menuEl) { e.stopPropagation(); closeMenu() } }, true)
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menuEl && lastState?.focus) void window.api.setFocus(null) })
  // 카드를 두 번 누르면 그 서비스의 사용량 페이지를 연다(한 번 누르기는 끌어서 순서 바꾸기와 겹치지 않게 비워 둔다).
  container.addEventListener('dblclick', async e => {
    const t = e.target as HTMLElement, card = t.closest<HTMLElement>('[data-card]')
    if (!card || t.closest('button')) return
    // Ctrl+두 번 클릭: CLI, Shift+두 번 클릭: 데스크톱 앱, 그냥 두 번 클릭: 집중 모드
    if (e.ctrlKey || e.shiftKey) { void openTool(e.ctrlKey ? 'cli' : 'app', card.dataset.card!); return }
    void window.api.setFocus(card.dataset.card!)
  })
  // 카드를 끌어 순서를 바꾼다(버튼 위에서 시작한 끌기와 오른쪽 단추는 제외).
  container.addEventListener('pointerdown', e => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')
    if (!card || e.button !== 0 || (e.target as HTMLElement).closest('button') || card.closest('.pv-win')) return
    // 보이는 카드가 한 장이면(집중 모드 포함) 바꿀 순서가 없으니 제목줄처럼 창 전체를 옮긴다.
    if (lastState?.focus || container.querySelectorAll('.service-grid [data-card]').length <= 1) { startWindowGesture(card, e, 'move'); return }
    startCardReorder(card, e)
  })
  // 카드 우클릭: 그 서비스의 메뉴(메인 프로세스의 기본 메뉴라 작은 위젯에서도 잘리지 않는다)
  container.addEventListener('contextmenu', e => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')
    if (!card) return
    e.preventDefault()
    void window.api.showCardMenu?.(card.dataset.card!)
  })
  // 숫자키 1~5로 크기, Ctrl+1~6으로 디자인 바꾸기(글자 입력 중이 아닐 때)
  document.addEventListener('keydown', e => {
    if ((e.target as HTMLElement).closest?.('input,textarea') || e.altKey || e.metaKey || e.shiftKey || e.repeat) return
    const m = /^Digit([1-9])$/.exec(e.code)
    if (!m) return
    const n = Number(m[1])
    if (e.ctrlKey) {
      if (n > DESIGNS.length) return
      e.preventDefault(); void update({ design: DESIGNS[n - 1][0] }); notify(`디자인: ${DESIGNS[n - 1][1]}`)
    } else if (n <= 5) void window.api.sizePreset(n).then(label => { if (label) notify(`크기: ${label}`) })
  })
}

function bindEvents(container: HTMLElement, state: AppState) {
  bindDelegated(container)
  container.querySelectorAll<HTMLElement>('[data-settings]').forEach(el => el.onclick = () => { void window.api.openSettings(el.dataset.settings as 'design' | 'services') })
  container.querySelectorAll<HTMLElement>('[data-action]').forEach(el => el.onclick = async () => {
    switch (el.dataset.action) {
      case 'refresh': try { await window.api.refreshQuota() } catch { notify('새로고침에 실패했어요.') }; break
      case 'hide': await window.api.hideWidget(); break
      case 'pin': { const on = lastState.config.alwaysOnTop === false; await update({ alwaysOnTop: on }); notify(on ? '항상 위에 표시해요.' : '다른 창 뒤로 갈 수 있어요.'); break }
    }
  })
  container.querySelectorAll<HTMLElement>('[data-window-drag],[data-resize]').forEach(el => el.onpointerdown = e => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    startWindowGesture(el, e, el.dataset.resize ? `resize-${el.dataset.resize}` : 'move')
  })
  container.onkeydown = null
}

/** 창 옮기기·크기 바꾸기 제스처(제목줄·가장자리, 카드가 한 장일 때는 카드). */
function startWindowGesture(el: HTMLElement, e: PointerEvent, kind: string) {
  e.preventDefault()
  el.setPointerCapture(e.pointerId)
  // 입력 주기(최대 1000Hz)마다 창을 옮기면 메인 프로세스에 작업이 밀리므로 화면 프레임마다 최신 좌표 하나만 보낸다.
  let pending: { x: number; y: number } | null = null, frame = 0
  const flush = () => { frame = 0; if (pending) window.api.moveInteraction?.(pending); pending = null }
  const onMove = (move: PointerEvent) => {
    if (!el.hasPointerCapture(move.pointerId)) return
    pending = { x: move.screenX, y: move.screenY }
    frame ||= requestAnimationFrame(flush)
  }
  el.onpointermove = onMove
  const stop = () => { cancelAnimationFrame(frame); el.onpointermove = null; el.onpointerup = null; el.onpointercancel = null }
  el.onpointerup = up => { void window.api.endInteraction?.({ x: up.screenX, y: up.screenY }); stop() }
  el.onpointercancel = () => { void window.api.endInteraction?.(); stop() }
  void window.api.beginInteraction(kind, { x: e.screenX, y: e.screenY }).catch(() => notify('창 조작을 시작하지 못했어요.'))
}

