import type { AppState } from '../../common/types.js'
import { visibleUsages } from '../../common/widget-layout.js'
import { lowestLeft, serviceModel, severity } from '../../common/usage-model.js'
import { renderCard, viewContext } from './usage-views.js'
import { applyAppearance, escapeText, icon } from './dashboard.js'
import { updateMarkup } from '../dom-update.js'

/**
 * 작업 표시줄 위젯을 눌렀을 때 뜨는 상세 팝업. 위젯 창과 같은 카드(종합 디자인)를 세로로 보여 준다.
 * 설정은 설정 창 하나에서만 바꾼다(예전 팝업의 계정·설정·API 탭은 설정 창으로 옮김).
 */
const CARD_H = 158

let bound = false
export function renderPopupView(container: HTMLElement, state: AppState, animate = false) {
  applyAppearance(state.config)
  let list = visibleUsages(state.usages, state.accounts, state.config)
  if (state.config.sortLowFirst) list = [...list].sort((a, b) => lowestLeft(serviceModel(a)) - lowestLeft(serviceModel(b)))
  const x = viewContext(state.config, state.history)
  const width = Math.max(240, (container.clientWidth || 380) - 22)
  const warnN = list.filter(u => severity(serviceModel(u), x.warn, x.crit)).length
  const updated = state.lastRefreshedAt ? new Date(state.lastRefreshedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : ''
  const loading = state.isRefreshing || state.usages.some(u => u.status === 'loading')
  const body = list.length
    ? list.map((u, i) => `<div class="pop-card" style="height:${CARD_H}px;--index:${i}">${renderCard(u, 'rich', x, { w: width, h: CARD_H })}</div>`).join('')
    : `<div class="empty-state">${icon(loading ? 'refresh' : 'grid')}<h2>${loading ? '서비스를 확인하고 있어요' : '표시할 서비스가 없어요'}</h2><button class="secondary-button" data-open-settings="services">서비스 관리</button></div>`
  updateMarkup(container, `<div class="dashboard popup-v2 ${animate ? 'popup-enter' : ''}">
    <header class="dashboard-header"><div class="window-handle"><span class="app-symbol" aria-hidden="true"><i></i><i></i><i></i></span><span class="app-title">AI 사용량</span><span class="header-status"><b>${loading ? '확인 중' : `${list.length}개`}</b>${updated && !state.preview ? ` · ${escapeText(updated)}` : ''}${warnN ? ` · <span class="w">${warnN}개 주의</span>` : ''}</span></div>
      <button class="tool ${state.isRefreshing ? 'is-refreshing' : ''}" data-pop="refresh" title="새로고침" aria-label="사용량 새로고침" ${state.isRefreshing ? 'disabled' : ''}>${icon('refresh')}</button>
      <button class="tool" data-pop="float" title="창으로 펼치기" aria-label="작업 표시줄에서 떼어 창으로 펼치기">${icon('expand')}</button>
      <button class="tool" data-open-settings="design" title="설정" aria-label="설정 열기">${icon('sliders')}</button>
      <button class="tool" data-pop="close" title="닫기 (Esc)" aria-label="닫기">${icon('close')}</button></header>
    <main class="pop-list">${body}</main>
  </div>`)
  if (bound) return
  bound = true
  // 이벤트는 한 번만 위임으로 건다(다시 그릴 때마다 쌓이지 않게).
  container.addEventListener('click', e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-pop],[data-open-settings]')
    if (!el) return
    if (el.dataset.openSettings) { void window.api.openSettings(el.dataset.openSettings as 'design'); void window.api.hidePopup(); return }
    if (el.dataset.pop === 'refresh') void window.api.refreshQuota()
    else if (el.dataset.pop === 'close') { void window.api.unlockPopup(); void window.api.hidePopup() }
    else if (el.dataset.pop === 'float') void window.api.updateConfig({ placementMode: 'floating' }).then(() => window.api.hidePopup())
  })
  // 카드를 두 번 누르면 그 서비스의 공식 사용량 페이지를 연다(위젯 창과 같은 동작).
  container.addEventListener('dblclick', e => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')
    if (card) void window.api.openServicePage(card.dataset.card!)
  })
}
