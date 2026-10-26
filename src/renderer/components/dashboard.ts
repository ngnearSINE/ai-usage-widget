import type { AccountUsage, AppState, QuotaInfo, WidgetConfig } from '../../common/types.js'
import { visibleUsages } from '../../common/widget-layout.js'
import { chooseLayout, DESIGNS, lowestLeft, serviceModel, severity, SOURCE_LABEL, type DesignId, type ValueSource } from '../../common/usage-model.js'
import { renderAiIcon } from './ai-icons.js'
import { renderCard, viewContext } from './usage-views.js'
import { updateMarkup } from '../dom-update.js'

const paths: Record<string, string> = {
  sliders: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8a7 7 0 0 1 11.6-2L20 9M4 15l2.3 3A7 7 0 0 0 18 16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  minus: '<path d="M5 12h14"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  dock: '<path d="M4 15V5h16v10M3 19h18M9 11l3 3 3-3M12 7v7"/>',
  arrow: '<path d="m7 17 10-10M7 7h10v10"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  hidden: '<path d="m3 3 18 18M10.6 5.1A14 14 0 0 1 12 5c6.5 0 10 7 10 7a20 20 0 0 1-3.5 4.4M6.3 6.4A22 22 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5-1.1"/>',
  up: '<path d="m6 14 6-6 6 6"/>', down: '<path d="m6 10 6 6 6-6"/>',
  chev: '<path d="m7 10 5 5 5-5"/>',
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
let lastState: AppState
let host: HTMLElement
let toastTimer: ReturnType<typeof setTimeout>
let mediaQuery: MediaQueryList | undefined
let layoutObserver: ResizeObserver | undefined
let layoutFrame = 0
let pageIndex = 0
let pageCount = 1
let delegated = false

export function applyAppearance(config: WidgetConfig) {
  document.documentElement.dataset.appearance = config.appearance === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : config.appearance || 'dark'
  document.documentElement.dataset.bar = config.barStyle || 'silk'
  document.documentElement.dataset.motion = config.motion || 'subtle'
  document.documentElement.dataset.acrylic = String(config.useAcrylic !== false)
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
  return `<div class="mini-summary">${renderAiIcon(u.provider, u.name, config.iconStyle, 20)}<div class="mini-quotas">${quotas.map((q, i) => {
    const value = available && q ? clamp(config.showUsedPercent ? q.percentUsed : q.percentLeft) : null
    const label = `${i === 0 ? (u.primaryKind === 'monthly' ? '월간' : '5시간') : '전체(주간)'} ${config.showUsedPercent ? '사용한 양' : '남은 양'}`
    return `<div class="mini-quota ${i === 1 ? 'secondary' : ''}" title="${label}: ${value === null ? '정보 없음' : `${value}%`}"><div class="meter"><div class="meter-fill" style="--value:${value ?? 0}%"></div></div><span class="mini-value" aria-label="${label}: ${value === null ? '정보 없음' : `${value}%`}">${value === null ? '—' : `${value}<small>%</small>`}</span></div>`
  }).join('')}</div></div>`
}
export function renderDockedUsage(u: AccountUsage, config: WidgetConfig) {
  return `<div class="docked-service" data-account-id="${escapeText(u.id)}" style="--brand:${color(u.brandColor)}" title="${escapeText(u.name)}${u.status === 'stale' ? ' · 갱신 지연' : ''}">${miniSummary(u, config)}</div>`
}

/** 트레이·다른 창에서 '디자인 설정'을 열 때. 설정은 별도 설정 창에서 한다. */
export function openDesign() { void window.api.openSettings('design') }

/* ---------- 본체 ---------- */
const designOf = (config: WidgetConfig): DesignId => (DESIGNS.some(d => d[0] === config.design) ? config.design : 'rich') as DesignId
function shownUsages(state: AppState) {
  const list = visibleUsages(state.usages, state.accounts, state.config)
  // 여유가 적은 순 정렬은 연결된 서비스끼리만, 연결 안 된 카드는 뒤로.
  return state.config.sortLowFirst
    ? [...list].sort((a, b) => lowestLeft(serviceModel(a)) - lowestLeft(serviceModel(b)))
    : list
}

export function renderDashboard(container: HTMLElement, state: AppState, force = false) {
  host = container
  lastState = state
  applyAppearance(state.config)
  if (!force && (busy || dragId)) return
  const design = designOf(state.config)
  updateMarkup(container, `<div class="dashboard">
    <header class="dashboard-header"><div class="window-handle" data-window-drag title="끌어서 창 이동 · 아래로 끌면 도킹"><span class="app-symbol" aria-hidden="true"><i></i><i></i><i></i></span><span class="app-title">AI 사용량</span><span class="header-status" data-status></span></div>
      <button class="view-btn" data-view-menu aria-haspopup="menu" title="보기 바꾸기">${DESIGNS.find(d => d[0] === design)![1]}${icon('chev')}</button>
      <button class="tool ${state.isRefreshing ? 'is-refreshing' : ''}" data-action="refresh" aria-label="사용량 새로고침" title="새로고침" ${state.isRefreshing ? 'disabled' : ''}>${icon('refresh')}</button>
      <button class="tool" data-settings="design" title="설정" aria-label="설정 열기">${icon('sliders')}</button>
      <button class="tool" data-settings="services" title="서비스 관리" aria-label="서비스 관리 열기">${icon('grid')}</button>
      <button class="tool window-hide" data-action="hide" title="트레이로 숨기기" aria-label="트레이로 숨기기">${icon('minus')}</button></header>
    <main class="dashboard-content" data-grid-host><div class="service-grid"></div></main>
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
  const warnN = all.filter(u => severity(serviceModel(u), x.warn, x.crit)).length
  const updated = state.lastRefreshedAt ? new Date(state.lastRefreshedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '--'
  const status = host.querySelector<HTMLElement>('[data-status]')
  const lock = state.config.clickThrough ? `<span class="lock-badge" title="클릭 통과 잠금 중">${icon('lock')}잠김${state.config.shortcuts?.lock ? ` · ${escapeText(state.config.shortcuts.lock)}로 풀기` : ''}</span> · ` : ''
  if (status) status.innerHTML = lock + (pages > 1
    ? `<button class="pager" data-page="-1" aria-label="이전 서비스">‹</button><span>${pageIndex + 1}/${pages}</span><button class="pager" data-page="1" aria-label="다음 서비스">›</button>${warnN ? ` · <span class="w">${warnN}개 주의</span>` : ''}`
    : `<b>${anyLoading ? '확인 중' : `${connected}개 연결`}</b> · ${state.preview ? '미리보기' : updated}${warnN ? ` · <span class="w">${warnN}개 주의</span>` : ''}${hidden > 0 ? ` · <button class="status-link" data-settings="services">${hidden}개 숨김</button>` : ''}`)
}

/* ---------- 메뉴 ---------- */
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
  container.addEventListener('click', e => {
    const t = e.target as HTMLElement
    const view = t.closest<HTMLElement>('[data-view-menu]')
    if (view) {
      e.stopPropagation()
      const current = designOf(lastState.config)
      openMenu(view, DESIGNS.map(([key, label, hint]) => ({ key, label, hint, on: current === key, run: () => { void update({ design: key }) } })))
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
    const pg = t.closest<HTMLElement>('[data-page]')
    if (pg) { pageIndex = (pageIndex + Number(pg.dataset.page) + pageCount) % pageCount; layoutCards(); return }
    if (menuEl && !t.closest('.menu')) closeMenu()
  })
  container.addEventListener('keydown', e => { if (e.key === 'Escape' && menuEl) { e.stopPropagation(); closeMenu() } }, true)
  // 카드를 두 번 누르면 그 서비스의 사용량 페이지를 연다(한 번 누르기는 끌어서 순서 바꾸기와 겹치지 않게 비워 둔다).
  container.addEventListener('dblclick', async e => {
    const t = e.target as HTMLElement, card = t.closest<HTMLElement>('[data-card]')
    if (!card || t.closest('button')) return
    try { if (!await window.api.openServicePage(card.dataset.card!)) notify('이 서비스는 열 수 있는 사용량 페이지가 없어요.') }
    catch { notify('사용량 페이지를 열지 못했어요.') }
  })
  // 카드를 끌어 순서를 바꾼다. 버튼 위에서 시작한 끌기는 무시한다.
  container.addEventListener('dragstart', e => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')
    if (!card || (e.target as HTMLElement).closest('button')) return
    dragId = card.dataset.card!
    e.dataTransfer!.setData('text/plain', dragId); e.dataTransfer!.effectAllowed = 'move'
    card.classList.add('dragging')
  })
  container.addEventListener('dragend', () => { dragId = null; renderDashboard(container, lastState, true) })
  container.addEventListener('dragover', e => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')
    if (dragId && card && card.dataset.card !== dragId) { e.preventDefault(); e.dataTransfer!.dropEffect = 'move'; container.querySelectorAll('.drop-target').forEach(c => c !== card && c.classList.remove('drop-target')); card.classList.add('drop-target') }
  })
  container.addEventListener('drop', async e => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')
    if (!card || !dragId) return
    e.preventDefault()
    const id = dragId; dragId = null
    try { const next = await window.api.moveAccount(id, card.dataset.card!); renderDashboard(container, next, true); notify('서비스 순서를 저장했어요.') }
    catch { notify('순서를 저장하지 못했어요.') }
  })
}

function bindEvents(container: HTMLElement, state: AppState) {
  bindDelegated(container)
  container.querySelectorAll<HTMLElement>('[data-settings]').forEach(el => el.onclick = () => { void window.api.openSettings(el.dataset.settings as 'design' | 'services') })
  container.querySelectorAll<HTMLElement>('[data-action]').forEach(el => el.onclick = async () => {
    switch (el.dataset.action) {
      case 'refresh': try { await window.api.refreshQuota() } catch { notify('새로고침에 실패했어요.') }; break
      case 'hide': await window.api.hideWidget(); break
    }
  })
  container.querySelectorAll<HTMLElement>('[data-window-drag],[data-resize]').forEach(el => el.onpointerdown = e => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
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
    void window.api.beginInteraction(el.dataset.resize ? `resize-${el.dataset.resize}` : 'move', { x: e.screenX, y: e.screenY }).catch(() => notify('창 조작을 시작하지 못했어요.'))
  })
  container.onkeydown = null
}

