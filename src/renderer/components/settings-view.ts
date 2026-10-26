import type { AppState, WidgetConfig } from '../../common/types.js'
import { visibleUsages, DEFAULT_WINDOW_SIZE } from '../../common/widget-layout.js'
import { chooseLayout, DESIGNS, lowestLeft, serviceModel, severity, SOURCE_LABEL, type DesignId, type ValueSource } from '../../common/usage-model.js'
import { previewUsages } from '../../common/preview-data.js'
import { downsample, previewHistory } from '../../common/history.js'
import type { HistoryPoint } from '../../common/types.js'
import { renderAiIcon } from './ai-icons.js'
import { renderCard, viewContext } from './usage-views.js'
import { applyAppearance, escapeText, icon } from './dashboard.js'
import { renderPopupTab } from './popup-view.js'
import { updateMarkup } from '../dom-update.js'

/** 설정 창: 왼쪽 미리보기(실제 위젯과 같은 렌더러·배치), 오른쪽 조절 항목. 슬라이더는 끄는 동안 미리보기에만, 놓으면 저장해 위젯에도 반영. */
type Tab = 'design' | 'display' | 'services' | 'alerts' | 'history' | 'convenience' | 'accounts' | 'general' | 'api'
const TABS: Array<[Tab, string]> = [['design', '디자인'], ['display', '표시'], ['services', '서비스'], ['alerts', '알림'], ['history', '기록'], ['convenience', '편의'], ['accounts', '계정'], ['general', '일반'], ['api', 'API']]
type SizeKey = 'current' | 'flat' | 'small' | 'tall' | 'large'
const SIZES: Array<[SizeKey, string, number, number]> = [['current', '현재 창', 0, 0], ['flat', '납작', 640, 110], ['small', '작게', 300, 220], ['tall', '세로', 300, 640], ['large', '크게', 980, 560]]

let tab: Tab = 'design'
let size: SizeKey = 'current'
let sample: 'auto' | 'real' | 'sample' = 'auto'
let state: AppState
let draft: WidgetConfig | null = null // 슬라이더를 끄는 동안의 임시 설정
let root: HTMLElement
let previewFrame = 0
let toastTimer: ReturnType<typeof setTimeout>

const number = (n: number | undefined, min: number, max: number, fallback: number) => Number.isFinite(n) ? Math.min(max, Math.max(min, n!)) : fallback
const hex = (v?: string) => /^#[\da-f]{6}$/i.test(v || '') ? v! : '#a99bff'
const config = () => draft || state.config

export function initSettings(container: HTMLElement, initial: AppState, initialTab?: string) {
  root = container
  root.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-win]')
    if (b) window.api.windowControl(b.dataset.win as 'minimize' | 'maximize' | 'close')
  })
  root.addEventListener('dblclick', e => { if ((e.target as HTMLElement).closest('.s-titlebar') && !(e.target as HTMLElement).closest('button')) window.api.windowControl('maximize') })
  if (TABS.some(t => t[0] === initialTab)) tab = initialTab as Tab
  renderSettings(initial)
  window.api.onSettingsTab?.(next => { if (TABS.some(t => t[0] === next)) { tab = next as Tab; renderSettings(state, true) } })
  new ResizeObserver(() => { cancelAnimationFrame(previewFrame); previewFrame = requestAnimationFrame(renderPreview) }).observe(container)
}

export function renderSettings(next: AppState, force = false) {
  state = next
  if (!force && draft) return // 슬라이더 조작 중에는 패널을 다시 그리지 않는다
  applyAppearance(config())
  const scroll = root.querySelector('.s-body')?.scrollTop || 0
  updateMarkup(root, `<div class="dashboard settings-root">
    <header class="s-titlebar"><span class="app-symbol" aria-hidden="true"><i></i><i></i><i></i></span><span class="app-title">AI 사용량 설정</span><span class="s-saved">${icon('check')} 바꾸면 바로 저장되고 위젯에도 반영돼요</span><div class="s-winbtns"><button data-win="minimize" title="최소화" aria-label="최소화"><svg viewBox="0 0 10 10"><path d="M0 5h10"/></svg></button><button data-win="maximize" title="최대화" aria-label="최대화"><svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg></button><button data-win="close" class="close" title="닫기" aria-label="닫기"><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg></button></div></header>
    <div class="s-main">
      <section class="s-preview" aria-label="미리보기">
        <div class="s-preview-bar"><div class="segmented s-sizes" role="group" aria-label="미리보기 크기">${SIZES.map(([k, label]) => `<button data-size="${k}" aria-pressed="${size === k}">${label}</button>`).join('')}</div>
          <div class="segmented s-sample" role="group" aria-label="미리보기 데이터"><button data-sample="real" aria-pressed="${usePreviewSample() ? 'false' : 'true'}">실제</button><button data-sample="sample" aria-pressed="${usePreviewSample()}">예시</button></div></div>
        <div class="s-stage" data-stage><div class="s-stage-inner" data-stage-inner></div></div>
        <p class="s-caption" data-caption></p>
      </section>
      <aside class="s-panel">
        <nav class="s-tabs" role="tablist">${TABS.map(([k, label]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${label}</button>`).join('')}</nav>
        <div class="s-body" data-body></div>
      </aside>
    </div>
    <div class="toast" role="status" aria-live="polite"></div>
  </div>`)
  const body = root.querySelector<HTMLElement>('[data-body]')!
  if (tab === 'accounts' || tab === 'general' || tab === 'api') {
    renderPopupTab(body, state, tab === 'general' ? 'settings' : tab)
    // 팝업의 '디자인 열기' 버튼은 이 창에서는 디자인 탭으로 보낸다.
    body.querySelector<HTMLElement>('#btn-open-design')?.addEventListener('click', e => { e.stopImmediatePropagation(); tab = 'design'; renderSettings(state, true) }, true)
  } else {
    body.innerHTML = tab === 'design' ? designTab(config()) : tab === 'display' ? displayTab(config()) : tab === 'alerts' ? alertsTab(state) : tab === 'history' ? historyTab() : tab === 'convenience' ? convenienceTab(state) : servicesTab(state)
    if (tab === 'history') void drawHistory()
  }
  body.scrollTop = scroll
  bindEvents()
  renderPreview()
}

/* ---------- 미리보기 ---------- */
let sampleHist: ReturnType<typeof previewHistory> | null = null
const sampleHistory = () => (sampleHist ||= previewHistory(previewUsages()))
function usePreviewSample() {
  if (sample !== 'auto') return sample === 'sample'
  return state.preview || !visibleUsages(state.usages, state.accounts, state.config).length
}
function previewSize(): [number, number] {
  if (size !== 'current') { const s = SIZES.find(x => x[0] === size)!; return [s[2], s[3]] }
  const b = state.config.windowBounds
  return [b?.width || DEFAULT_WINDOW_SIZE.width, b?.height || DEFAULT_WINDOW_SIZE.height]
}
function renderPreview() {
  const stage = root?.querySelector<HTMLElement>('[data-stage]'), inner = root?.querySelector<HTMLElement>('[data-stage-inner]')
  if (!stage || !inner || !state) return
  const cfg = config(), [W, H] = previewSize()
  const usages = usePreviewSample() ? previewUsages() : state.usages
  const accounts = usePreviewSample() ? usages.map(u => ({ id: u.id, name: u.name, provider: u.provider, enabled: true })) : state.accounts
  let list = visibleUsages(usages, accounts, cfg)
  if (cfg.sortLowFirst) list = [...list].sort((a, b) => lowestLeft(serviceModel(a)) - lowestLeft(serviceModel(b)))
  const design = (DESIGNS.some(d => d[0] === cfg.design) ? cfg.design : 'rich') as DesignId
  const gap = number(cfg.cardGap, 4, 16, 6), x = viewContext(cfg, usePreviewSample() ? sampleHistory() : state.history)
  // 위젯과 같은 계산: 제목줄 36px, 카드 영역 안쪽 여백 6px.
  const gw = W - 12, gh = H - 36 - 12
  let grid = '', note = ''
  if (!list.length) grid = `<div class="service-grid empty"><div class="empty-state"><h2>표시할 서비스가 없어요</h2></div></div>`
  else {
    const L = chooseLayout(gw, gh, list.length, design, gap), shown = list.slice(0, L.per), spare = L.rows * L.cols - shown.length
    grid = `<div class="service-grid" style="grid-template-columns:repeat(${L.cols},minmax(0,1fr));grid-template-rows:repeat(${L.rows},minmax(0,1fr))">${shown.map((u, i) => {
      const last = spare && i === shown.length - 1, w = last ? L.cw * (spare + 1) + gap * spare : L.cw
      return renderCard(u, design, x, { w, h: L.ch }, last ? `grid-column:span ${spare + 1};` : '')
    }).join('')}</div>`
    if (L.per < list.length) note = ` · ${list.length}개 중 ${L.per}개씩 페이지로 표시`
  }
  const warnN = list.filter(u => severity(serviceModel(u), x.warn, x.crit)).length
  // 스테이지에 맞게 축소만 한다(확대하지 않음).
  const k = Math.min(1, (stage.clientWidth - 32) / W, (stage.clientHeight - 32) / H)
  updateMarkup(inner, `<div class="pv-win" style="width:${W}px;height:${H}px;transform:scale(${k.toFixed(3)})">
    <div class="dashboard-header"><div class="window-handle"><span class="app-symbol" aria-hidden="true"><i></i><i></i><i></i></span><span class="app-title">AI 사용량</span><span class="header-status"><b>${list.length}개 연결</b>${warnN ? ` · <span class="w">${warnN}개 주의</span>` : ''}</span></div><span class="view-btn">${DESIGNS.find(d => d[0] === design)![1]}${icon('chev')}</span></div>
    <div class="dashboard-content">${grid}</div></div>`)
  inner.style.width = `${Math.round(W * k)}px`; inner.style.height = `${Math.round(H * k)}px`
  const cap = root.querySelector<HTMLElement>('[data-caption]')
  if (cap) cap.textContent = `${W}×${H}${size === 'current' ? ' (지금 위젯 크기)' : ''}${k < 1 ? ` · ${Math.round(k * 100)}%로 축소해 표시` : ''}${note}${usePreviewSample() ? ' · 예시 데이터' : ''}`
}

/* ---------- 탭 내용 ---------- */
const presets = [['silk', '실크', '부드럽고 차분하게'], ['aurora', '오로라', '은은하게 흐르는 빛'], ['neon', '네온', '선명한 빛의 대비'], ['segments', '세그먼트', '정교한 리듬감'], ['mono', '모노', '덜어낸 아름다움'], ['spectrum', '스펙트럼', '다채로운 에너지']]
const segment = (key: string, current: string, options: string[][]) => `<div class="segmented" role="group">${options.map(([value, label]) => `<button data-config="${key}" data-value="${value}" aria-pressed="${current === value}">${label}</button>`).join('')}</div>`
const toggle = (key: keyof WidgetConfig, label: string, description: string, value: boolean) => `<label class="setting-row"><span><b>${label}</b>${description ? `<small>${description}</small>` : ''}</span><input class="switch" type="checkbox" data-toggle="${key}" ${value ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span></label>`
const slider = (key: string, label: string, min: number, max: number, value: number, unit: string) => `<label class="slider-setting"><span>${label}<output>${value}${unit}</output></span><input type="range" data-range="${key}" data-unit="${unit}" min="${min}" max="${max}" value="${value}" aria-label="${label}"></label>`
const section = (label: string, inner: string, hint = '') => `<section class="editor-section"><div class="section-label">${label}${hint ? `<span>${hint}</span>` : ''}</div>${inner}</section>`

function designTab(c: WidgetConfig) {
  return section('디자인', `<div class="design-grid">${DESIGNS.map(([id, name, desc]) => `<button class="design-choice" data-config="design" data-value="${id}" aria-pressed="${(c.design || 'rich') === id}"><b>${name}</b><small>${desc}</small></button>`).join('')}</div>`, '위젯 제목줄의 보기 버튼으로도 바꿀 수 있어요')
    + section('분위기', segment('appearance', c.appearance || 'dark', [['light', '라이트'], ['dark', '다크'], ['system', '시스템']]))
    + section('배경', `${state.acrylicSupported === false ? '' : toggle('useAcrylic', '아크릴', '창 뒤를 흐리게 비춰요. 끄면 흐림 없이 그대로 비쳐요.', c.useAcrylic !== false)}`
      + slider('opacity', '불투명도', 0, 100, c.opacity ?? 70, '%')
      + `<p class="setting-hint">Windows Terminal과 같은 방식이에요. 100%는 단색이고, 낮출수록 뒤가 비쳐요. 위젯·팝업·설정 창에 함께 적용돼요.${state.acrylicSupported === false ? ' 이 Windows에서는 아크릴을 쓸 수 없어 흐림 없이 비쳐요.' : ''}</p>`)
    + section('막대 색 스타일', `<div class="preset-grid">${presets.map(([id, name, desc]) => `<button class="preset ${(c.barStyle || 'silk') === id ? 'selected' : ''}" data-config="barStyle" data-value="${id}" data-preview="${id}" aria-pressed="${(c.barStyle || 'silk') === id}"><span class="preset-sample"><i></i><i></i></span><span class="preset-name">${name}${(c.barStyle || 'silk') === id ? icon('check') : ''}</span><small>${desc}</small></button>`).join('')}</div>`, '경고색이 있을 때는 경고색이 우선해요')
    + section('강조색', `<div class="color-swatches">${['#a99bff', '#79c7b2', '#8cbbff', '#f1ae8c', '#f29dc1', '#e3cf83'].map(col => `<button style="--swatch:${col}" data-config="accentColor" data-value="${col}" aria-label="강조색 ${col}" aria-pressed="${c.accentColor === col}">${c.accentColor === col ? icon('check') : ''}</button>`).join('')}<label class="custom-color" title="직접 고르기"><input type="color" value="${hex(c.accentColor)}" aria-label="강조색 직접 선택" data-color></label></div>`)
    + section('크기와 간격', slider('fontScale', '글자 크기', 85, 130, c.fontScale || 100, '%') + slider('cardGap', '카드 사이 간격', 4, 16, c.cardGap ?? 6, 'px'))
    + section('움직임', segment('motion', c.motion || 'subtle', [['off', '없음'], ['subtle', '은은하게'], ['expressive', '생동감 있게']]) + '<p class="setting-hint">시스템의 동작 줄이기 설정도 함께 적용합니다.</p>')
}
function displayTab(c: WidgetConfig) {
  const warn = c.warnPercent ?? 20
  const src = new Set(Object.values(c.valueSource || {}))
  const common: ValueSource | '' = src.size === 1 ? [...src][0] as ValueSource : src.size === 0 ? 'weekly' : ''
  return section('큰 숫자 기준', `<div class="segmented" role="group">${(Object.keys(SOURCE_LABEL) as ValueSource[]).map(k => `<button data-source-all="${k}" aria-pressed="${common === k}">${SOURCE_LABEL[k]}</button>`).join('')}</div><p class="setting-hint">모든 카드에 적용합니다. 카드마다 다르게 하려면 위젯 카드의 기준 버튼(주간 ▾)을 쓰세요.${common ? '' : ' 지금은 카드마다 다르게 설정되어 있어요.'}</p>`)
    + section('여유 부족 강조', slider('warnPercent', '주의 기준(남은 양)', 5, 50, warn, '%') + slider('critPercent', '위험 기준(남은 양)', 0, warn, Math.min(warn, c.critPercent ?? 10), '%')
      + toggle('colorByUsage', '경고색 사용', '기준 아래로 내려가면 숫자와 그래프를 경고색으로 칠합니다.', c.colorByUsage !== false)
      + toggle('sortLowFirst', '여유가 적은 서비스를 앞으로', '', !!c.sortLowFirst)
      + '<p class="setting-hint">속도만으로는 리셋보다 주기의 15% 이상 먼저 바닥날 것으로 보이고 남은 양이 50% 이하일 때 주의로 표시합니다.</p>')
    + section('표시할 정보', toggle('showUsedPercent', '사용한 양으로 표시', '끄면 남은 양을 표시합니다.', !!c.showUsedPercent)
      + toggle('showPace', '페이스 눈금', '리셋 주기에서 지난 시간만큼이라면 남아 있어야 할 위치를 표시합니다.', c.showPace !== false)
      + toggle('showResetTime', '리셋까지 남은 시간', '', c.showResetTime !== false))
    + section('창 동작', toggle('alwaysOnTop', '항상 위에 표시', '다른 창 위에서 사용량을 확인합니다.', c.alwaysOnTop !== false)
      + `<button class="secondary-button" data-action="dock">${icon('dock')}작업표시줄에 도킹</button><p class="setting-hint">위젯 제목줄을 화면 아래로 끌어도 도킹됩니다.</p>`)
}
function servicesTab(s: AppState) {
  return section('표시', toggle('hideDisconnected', '미연결 서비스 자동 숨김', '일시 오류는 마지막 확인 값을 유지합니다.', !!s.config.hideDisconnected)
      + '<p class="setting-hint">눈 아이콘은 위젯 창과 작업 표시줄 모두에서, 작업 표시줄 아이콘은 작업 표시줄에서만 숨깁니다. 조회를 끄려면 스위치를 끄세요. 위젯에서 카드를 끌어 순서를 바꿀 수도 있어요.</p>')
    + `<div class="service-manager">${s.accounts.map((a, index) => {
      const u = s.usages.find(u => u.id === a.id)
      const status = !a.enabled ? '조회 꺼짐' : a.hidden ? '수동 숨김' : u?.status === 'ready' ? '연결됨' : u?.status === 'stale' ? '갱신 지연' : u?.status === 'loading' ? '확인 중' : '연결 안 됨'
      const name = escapeText(a.name)
      // 모델 전용 주간 한도(Fable 등)가 있는 계정만 보기 스위치를 둔다.
      const scopedNames = u?.scopedQuotas?.map(s => s.label) || u?.scopedHidden || []
      return `<div class="managed-service">${renderAiIcon(a.provider, a.name, s.config.iconStyle, 28)}<span><b class="svc-name" data-name-of="${escapeText(a.id)}">${name}</b><small>${status}${u?.tier && a.orgUuid ? ` · ${escapeText(u.tier)}` : ''}</small>${scopedNames.length ? `<label class="scoped-toggle"><input type="checkbox" data-scoped="${escapeText(a.id)}" ${a.showScoped === false ? '' : 'checked'}><span>${escapeText(scopedNames.join('·'))} 한도 표시</span></label>` : ''}</span><button class="tool" data-rename="${escapeText(a.id)}" title="이름 바꾸기" aria-label="${name} 이름 바꾸기">${icon('pencil')}</button><div class="managed-order"><button class="tool" data-order="up" data-id="${escapeText(a.id)}" ${index === 0 ? 'disabled' : ''} aria-label="${name} 앞으로 이동">${icon('up')}</button><button class="tool" data-order="down" data-id="${escapeText(a.id)}" ${index === s.accounts.length - 1 ? 'disabled' : ''} aria-label="${name} 뒤로 이동">${icon('down')}</button></div><button class="tool ${a.hiddenInDock ? 'is-off' : ''}" data-dock-hide="${escapeText(a.id)}" aria-pressed="${!!a.hiddenInDock}" title="${a.hiddenInDock ? '작업 표시줄에서 숨김 중(위젯 창에는 보임)' : '작업 표시줄에도 표시'}" aria-label="${name} 작업 표시줄에서 ${a.hiddenInDock ? '다시 표시' : '숨기기'}">${icon('taskbar')}</button><button class="tool" data-hide="${escapeText(a.id)}" title="${a.hidden ? '숨김 중(위젯 창·작업 표시줄 모두)' : '위젯 창·작업 표시줄에 표시'}" aria-label="${name} ${a.hidden ? '다시 표시' : '숨기기'}" aria-pressed="${!!a.hidden}">${icon(a.hidden ? 'hidden' : 'eye')}</button><label class="mini-toggle"><input type="checkbox" class="switch" data-enabled="${escapeText(a.id)}" aria-label="${name} 조회" ${a.enabled ? 'checked' : ''}><span class="switch-track"></span></label></div>`
    }).join('')}</div><button class="secondary-button" data-goto="accounts">계정 추가 · 감지 ${icon('arrow')}</button>`
}

function alertsTab(s: AppState) {
  const c = s.config, on = c.notifyEnabled !== false, warn = c.warnPercent ?? 20, crit = Math.min(warn, c.critPercent ?? 10)
  const muted = new Set(c.notifyMuted || [])
  // 서비스마다 실제로 있는 한도만 보여 준다(주간 전용 계정은 주간만).
  const rows = s.accounts.filter(a => a.enabled).map(a => {
    const u = s.usages.find(u => u.id === a.id)
    const first = u?.primaryKind === 'monthly' ? '월간' : '5시간'
    const keys: Array<['5h' | 'weekly', string]> = u?.isWeeklyOnly ? [['weekly', '주간']] : u && !u.weeklyQuota ? [['5h', first]] : [['5h', first], ['weekly', '주간']]
    return `<div class="alert-row"><span class="alert-name">${renderAiIcon(a.provider, a.name, c.iconStyle, 20)}<b>${escapeText(a.name)}</b></span>${[['5h', first], ['weekly', '주간']].map(([k, label]) => keys.some(x => x[0] === k)
      ? `<label class="alert-check"><input type="checkbox" data-mute="${escapeText(a.id)}:${k}" ${muted.has(`${a.id}:${k}`) ? '' : 'checked'} ${on ? '' : 'disabled'}><span>${label}</span></label>` : '<span class="alert-check none">—</span>').join('')}</div>`
  }).join('')
  return section('Windows 알림', toggle('notifyEnabled', '알림 사용', '켜 두면 아래 조건에서 Windows 알림을 보냅니다.', on)
      + `<button class="secondary-button" data-test-notify>테스트 알림 보내기</button><p class="setting-hint">Windows 설정에서 알림이 꺼져 있거나 방해 금지 모드이면 보이지 않을 수 있어요. 알림을 누르면 위젯이 나타납니다.</p>`)
    + `<div class="${on ? '' : 'is-disabled'}">`
    + section('알릴 때', toggle('notifyLow', '여유 부족', `남은 양이 주의 ${warn}%·위험 ${crit}%에 처음 닿을 때 한 번씩(기준은 표시 탭에서 바꿔요).`, c.notifyLow !== false)
      + toggle('notifyPace', '소진 예상', '지금 속도면 리셋 전에 바닥날 것 같을 때(대시보드의 속도 주의와 같은 조건).', c.notifyPace !== false)
      + toggle('notifyReset', '리셋', '빠듯했던 한도가 새로 채워졌을 때.', c.notifyReset === true)
      + toggle('notifyUnused', '남는 주간 여유', '주간 리셋이 24시간 안에 다가왔는데 40% 이상 남았을 때.', c.notifyUnused !== false)
      + '<p class="setting-hint">같은 리셋 주기 안에서는 종류마다 한 번만 알립니다. 앱을 다시 켜도 반복하지 않아요. 갱신이 지연된 값으로는 알리지 않습니다.</p>')
    + section('서비스별', rows ? `<div class="alert-table">${rows}</div>` : '<p class="setting-hint">조회 중인 서비스가 없어요.</p>', '체크한 한도만 알려요')
    + '</div>'
}

let histId = ''
let histRange: 'day' | 'week' = 'day'
function historyServices() {
  const usages = usePreviewSample() ? previewUsages() : state.usages
  return usages.filter(u => ['ready', 'stale'].includes(u.status))
}
function historyTab() {
  const list = historyServices()
  if (!list.some(u => u.id === histId)) histId = list[0]?.id || ''
  if (!list.length) return section('사용 기록', '<p class="setting-hint">아직 기록이 없어요. 사용량을 조회할 때마다 이 PC에 쌓이고 30일 동안 보관합니다.</p>')
  return section('서비스', `<div class="chip-row">${list.map(u => `<button class="chip-btn" data-hist="${escapeText(u.id)}" aria-pressed="${u.id === histId}">${renderAiIcon(u.provider, u.name, state.config.iconStyle, 16)}${escapeText(u.name)}</button>`).join('')}</div>`)
    + section('기간', `<div class="segmented" role="group"><button data-hrange="day" aria-pressed="${histRange === 'day'}">최근 24시간</button><button data-hrange="week" aria-pressed="${histRange === 'week'}">최근 7일</button></div>`)
    + `<section class="editor-section"><div class="hist-chart" data-hist-chart><p class="setting-hint">불러오는 중…</p></div><p class="setting-hint">남은 양(%) 기준입니다. 사용량을 조회할 때마다 이 PC에만 기록하고 30일 동안 보관합니다.${usePreviewSample() ? ' 지금은 예시 기록을 보여 주고 있어요.' : ''}</p></section>`
}
async function drawHistory() {
  const box = root.querySelector<HTMLElement>('[data-hist-chart]'); if (!box || !histId) return
  const now = Date.now(), span = histRange === 'day' ? 86400e3 : 7 * 86400e3, from = now - span
  const u = historyServices().find(x => x.id === histId)!
  let pts: HistoryPoint[]
  try { pts = usePreviewSample() ? downsample(sampleHistory()[histId] || [], from, now, 200) : await window.api.getHistory(histId, from, now, 200) }
  catch { box.innerHTML = '<p class="setting-hint">기록을 불러오지 못했어요.</p>'; return }
  if (pts.length < 2) { box.innerHTML = '<p class="setting-hint">이 기간에는 기록이 아직 충분하지 않아요.</p>'; return }
  const W = 300, H = 140, L = 26, B = 18
  const px = (t: number) => L + (t - from) / span * (W - L - 4), py = (v: number) => 4 + (1 - v / 100) * (H - B - 4)
  const line = (idx: 1 | 2) => { const ps = pts.filter(p => p[idx] !== null); return ps.length < 2 ? '' : ps.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)} ${py(p[idx]!).toFixed(1)}`).join('') }
  const brand = hex(u.brandColor), l5 = line(1), lw = line(2)
  const ticks: Array<[number, string]> = histRange === 'day' ? [[from, '24시간 전'], [from + span / 2, '12시간 전'], [now, '지금']] : [[from, '7일 전'], [from + span * 4 / 7, '3일 전'], [now, '지금']]
  const lows = (idx: 1 | 2) => { const v = pts.map(p => p[idx]).filter((n): n is number => n !== null); return v.length ? Math.min(...v) : null }
  const weekColor = `color-mix(in srgb,${brand} 55%,var(--muted))`
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="hist-svg" role="img" aria-label="${escapeText(u.name)} 남은 양 추이">`
    + [0, 50, 100].map(v => `<line x1="${L}" x2="${W - 4}" y1="${py(v)}" y2="${py(v)}" stroke="var(--line)"/><text x="${L - 4}" y="${py(v) + 3}" text-anchor="end" font-size="8" fill="var(--dim)">${v}</text>`).join('')
    + ticks.map(([t, label], i) => `<text x="${px(t)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" font-size="8" fill="var(--dim)">${label}</text>`).join('')
    + (lw ? `<path d="${lw}" fill="none" stroke="${weekColor}" stroke-width="1.6" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>` : '')
    + (l5 ? `<path d="${l5}" fill="none" stroke="${brand}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>` : '')
    + `</svg><div class="hist-legend">${l5 ? `<span><i style="background:${brand}"></i>5시간 · 최저 ${lows(1)}%</span>` : ''}${lw ? `<span><i class="dash" style="border-color:${weekColor}"></i>주간 · 최저 ${lows(2)}%</span>` : ''}</div>`
}

const SHORTCUT_DEFAULTS = { toggle: 'Ctrl+Alt+U', lock: 'Ctrl+Alt+L', cycle: 'Ctrl+Alt+D' }
type ShortcutKey = keyof typeof SHORTCUT_DEFAULTS
function convenienceTab(s: AppState) {
  const c = s.config, sc = { ...SHORTCUT_DEFAULTS, ...c.shortcuts }, errors = s.shortcutErrors || []
  const saved = Object.keys(c.layoutsByMonitor || {}).length
  const row = (k: ShortcutKey, label: string) => `<div class="sc-row"><span class="sc-label">${label}</span><input class="sc-input" data-shortcut="${k}" readonly value="${escapeText(sc[k] || '')}" placeholder="꺼짐" aria-label="${label} 단축키(눌러서 입력)"><button class="tool" data-sc-clear="${k}" title="끄기" aria-label="${label} 단축키 끄기">${icon('close')}</button><button class="sc-reset" data-sc-default="${k}" ${sc[k] === SHORTCUT_DEFAULTS[k] ? 'disabled' : ''}>기본값</button></div>`
  return section('트레이', toggle('trayShowNumber', '트레이 아이콘에 숫자', '가장 빠듯한 서비스의 남은 %를 트레이 아이콘에 표시하고, 주의·위험이면 색으로 알려요. 위젯을 숨겨도 확인할 수 있어요.', c.trayShowNumber !== false))
    + section('클릭 통과 잠금', toggle('clickThrough', '잠그기', '위젯 위 클릭이 뒤 창으로 지나가요. 자유 창에서만 동작하고, 마우스로는 풀 수 없으니 단축키나 트레이 메뉴로 풀어요.', !!c.clickThrough))
    + section('전역 단축키', `<div class="sc-list">${row('toggle', '위젯 보이기/숨기기')}${row('lock', '클릭 통과 잠금/해제')}${row('cycle', '디자인 순환')}</div>
      <p class="setting-hint">칸을 누른 뒤 원하는 조합(Ctrl·Alt·Shift + 글자)을 누르세요. Esc는 취소, Backspace는 끄기입니다.</p>
      ${errors.length ? `<p class="setting-hint warn-text">등록하지 못한 단축키: ${escapeText(errors.join(', '))} — 다른 앱이 쓰고 있을 수 있어요. 다른 조합으로 바꿔 주세요.</p>` : ''}`)
    + section('모니터별 배치', toggle('rememberPerMonitor', '모니터 구성마다 기억', '모니터를 연결하거나 뺄 때, 그 구성에서 쓰던 위치·크기·디자인으로 돌아가요.', c.rememberPerMonitor !== false)
      + `<p class="setting-hint">저장된 구성 ${saved}개</p>${saved ? '<button class="secondary-button" data-clear-layouts>저장된 구성 모두 지우기</button>' : ''}`)
    + section('카드 동작', '<p class="setting-hint">위젯 카드를 두 번 누르면 그 서비스의 사용량 페이지(Claude·Codex)를 기본 브라우저로 열어요. 한 번 누르기는 끌어서 순서를 바꾸는 데 써요.</p>')
}
function shortcutFromEvent(e: KeyboardEvent): string | null {
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]
  const k = e.key.length === 1 ? e.key.toUpperCase() : /^F\d{1,2}$/.test(e.key) ? e.key : null
  // 글자 단독은 다른 앱의 입력을 막으므로 Ctrl 또는 Alt를 반드시 함께 쓴다.
  if (!k || !/^[A-Z0-9]$|^F\d{1,2}$/.test(k) || !(e.ctrlKey || e.altKey)) return null
  return [...mods, k].join('+')
}

/* ---------- 이벤트 ---------- */
function notify(message: string) {
  const toast = root.querySelector<HTMLElement>('.toast'); if (!toast) return
  clearTimeout(toastTimer); toast.textContent = message; toast.classList.add('visible')
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2200)
}
async function update(patch: Partial<WidgetConfig>) {
  try { draft = null; const next = await window.api.updateConfig(patch); renderSettings(next, true) }
  catch { notify('설정을 저장하지 못했어요. 다시 시도해 주세요.') }
}
function bindEvents() {
  root.querySelectorAll<HTMLElement>('[data-tab]').forEach(el => el.onclick = () => { tab = el.dataset.tab as Tab; renderSettings(state, true) })
  root.querySelectorAll<HTMLElement>('[data-goto]').forEach(el => el.onclick = () => { tab = el.dataset.goto as Tab; renderSettings(state, true) })
  root.querySelectorAll<HTMLElement>('[data-size]').forEach(el => el.onclick = () => { size = el.dataset.size as SizeKey; renderSettings(state, true) })
  root.querySelectorAll<HTMLElement>('[data-sample]').forEach(el => el.onclick = () => { sample = el.dataset.sample as 'real' | 'sample'; renderSettings(state, true) })
  const body = root.querySelector<HTMLElement>('[data-body]')!
  if (tab === 'accounts' || tab === 'general' || tab === 'api') return // 이 탭들은 팝업 코드가 이벤트를 붙인다
  body.querySelectorAll<HTMLElement>('[data-config]').forEach(el => el.onclick = () => { void update({ [el.dataset.config!]: el.dataset.value }) })
  body.querySelectorAll<HTMLInputElement>('[data-toggle]').forEach(el => el.onchange = () => { void update({ [el.dataset.toggle!]: el.checked }) })
  body.querySelectorAll<HTMLElement>('[data-source-all]').forEach(el => el.onclick = () => {
    const v = el.dataset.sourceAll as ValueSource, all: Record<string, ValueSource> = {}
    for (const a of state.accounts) all[a.id] = v
    void update({ valueSource: all })
  })
  body.querySelectorAll<HTMLInputElement>('[data-range]').forEach(el => {
    el.oninput = () => {
      el.closest('label')!.querySelector('output')!.textContent = `${el.value}${el.dataset.unit || ''}`
      // 끄는 동안에는 미리보기에만 반영한다.
      draft = { ...config(), [el.dataset.range!]: Number(el.value) }
      applyAppearance(draft)
      renderPreview()
    }
    el.onchange = () => { void update({ [el.dataset.range!]: Number(el.value) }) }
  })
  const colorInput = body.querySelector<HTMLInputElement>('[data-color]')
  if (colorInput) colorInput.onchange = () => { void update({ accentColor: colorInput.value }) }
  body.querySelectorAll<HTMLElement>('[data-action="dock"]').forEach(el => el.onclick = () => { void update({ placementMode: 'docked' }) })
  body.querySelectorAll<HTMLInputElement>('[data-shortcut]').forEach(el => {
    el.onkeydown = e => {
      e.preventDefault()
      const k = el.dataset.shortcut as ShortcutKey, cur = { ...SHORTCUT_DEFAULTS, ...config().shortcuts }
      if (e.key === 'Escape') { el.blur(); return }
      if (e.key === 'Backspace' || e.key === 'Delete') { void update({ shortcuts: { ...cur, [k]: '' } }); return }
      const accel = shortcutFromEvent(e)
      if (!accel) { el.value = 'Ctrl 또는 Alt와 함께 눌러 주세요'; return }
      if (Object.entries(cur).some(([other, v]) => other !== k && v === accel)) { notify('다른 동작에 이미 쓰는 조합이에요.'); return }
      void update({ shortcuts: { ...cur, [k]: accel } })
    }
    el.onblur = () => { el.value = ({ ...SHORTCUT_DEFAULTS, ...config().shortcuts })[el.dataset.shortcut as ShortcutKey] || '' }
  })
  body.querySelectorAll<HTMLElement>('[data-sc-clear]').forEach(el => el.onclick = () => { void update({ shortcuts: { ...SHORTCUT_DEFAULTS, ...config().shortcuts, [el.dataset.scClear!]: '' } }) })
  body.querySelectorAll<HTMLElement>('[data-sc-default]').forEach(el => el.onclick = () => { const k = el.dataset.scDefault as ShortcutKey; void update({ shortcuts: { ...SHORTCUT_DEFAULTS, ...config().shortcuts, [k]: SHORTCUT_DEFAULTS[k] } }) })
  body.querySelector<HTMLElement>('[data-clear-layouts]')?.addEventListener('click', () => { void update({ layoutsByMonitor: {} }) })
  body.querySelectorAll<HTMLElement>('[data-hist]').forEach(el => el.onclick = () => { histId = el.dataset.hist!; renderSettings(state, true) })
  body.querySelectorAll<HTMLElement>('[data-hrange]').forEach(el => el.onclick = () => { histRange = el.dataset.hrange as 'day' | 'week'; renderSettings(state, true) })
  body.querySelectorAll<HTMLInputElement>('[data-mute]').forEach(el => el.onchange = () => {
    const set = new Set(config().notifyMuted || [])
    if (el.checked) set.delete(el.dataset.mute!); else set.add(el.dataset.mute!)
    void update({ notifyMuted: [...set] })
  })
  body.querySelector<HTMLElement>('[data-test-notify]')?.addEventListener('click', async () => {
    try { notify(await window.api.testNotification() ? '테스트 알림을 보냈어요.' : '이 PC에서는 Windows 알림을 쓸 수 없어요.') }
    catch { notify('테스트 알림을 보내지 못했어요.') }
  })
  body.querySelectorAll<HTMLElement>('[data-hide]').forEach(el => el.onclick = async () => {
    const id = el.dataset.hide!, account = state.accounts.find(a => a.id === id)!
    try { await window.api.hideAccount(id, !account.hidden) } catch { notify('표시 설정을 저장하지 못했어요.') }
  })
  body.querySelectorAll<HTMLElement>('[data-rename]').forEach(el => el.onclick = () => {
    const id = el.dataset.rename!, b = body.querySelector<HTMLElement>(`[data-name-of="${CSS.escape(id)}"]`)
    if (!b || b.querySelector('input')) return
    const input = document.createElement('input')
    input.className = 'rename-input'; input.value = b.textContent || ''; input.maxLength = 60
    input.setAttribute('aria-label', '새 이름')
    b.replaceChildren(input); input.focus(); input.select()
    let done = false
    const finish = (save: boolean) => {
      if (done) return
      done = true
      const name = input.value.trim()
      if (save && name && name !== state.accounts.find(a => a.id === id)?.name) void window.api.renameAccount(id, name).catch(() => notify('이름을 저장하지 못했어요.'))
      else renderSettings(state, true)
    }
    input.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false) }
    input.onblur = () => finish(true)
  })
  body.querySelectorAll<HTMLElement>('[data-dock-hide]').forEach(el => el.onclick = () => {
    const a = state.accounts.find(x => x.id === el.dataset.dockHide)
    if (a) void window.api.setAccountDisplay(a.id, { hiddenInDock: !a.hiddenInDock }).catch(() => notify('표시 설정을 저장하지 못했어요.'))
  })
  body.querySelectorAll<HTMLInputElement>('[data-scoped]').forEach(el => el.onchange = () => { void window.api.setAccountDisplay(el.dataset.scoped!, { showScoped: el.checked }).catch(() => notify('표시 설정을 저장하지 못했어요.')) })
  body.querySelectorAll<HTMLInputElement>('[data-enabled]').forEach(el => el.onchange = () => { void window.api.toggleAccount(el.dataset.enabled!, el.checked).catch(() => notify('조회 설정을 저장하지 못했어요.')) })
  body.querySelectorAll<HTMLElement>('[data-order]').forEach(el => el.onclick = () => {
    void window.api.reorderAccount(el.dataset.id!, el.dataset.order as 'up' | 'down').catch(() => notify('순서를 저장하지 못했어요.'))
  })
}
