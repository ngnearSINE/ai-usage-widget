import type { AccountConfig, AppState, WidgetConfig, HeatSide } from '../../common/types.js'
import { visibleUsages, DEFAULT_WINDOW_SIZE } from '../../common/widget-layout.js'
import { chooseLayout, DESIGNS, lowestLeft, serviceModel, severity, SOURCE_LABEL, type DesignId, type ValueSource } from '../../common/usage-model.js'
import { previewUsages } from '../../common/preview-data.js'
import { downsample, previewHistory } from '../../common/history.js'
import type { HistoryPoint } from '../../common/types.js'
import { renderAiIcon } from './ai-icons.js'
import { renderCard, viewContext } from './usage-views.js'
import { applyAppearance, escapeText, icon, updateHourSelect, heatPlacement } from './dashboard.js'
import { updateMarkup } from '../dom-update.js'
import { SMOOTH_START } from '../../common/bar-color.js'
import { DISPLAY_KEYS, displayOf, displaySummary, setDisplay, setDisplayAll, type DisplayKey } from '../../common/display-options.js'

/**
 * 설정 창: 왼쪽 미리보기(실제 위젯과 같은 렌더러·배치), 오른쪽 조절 항목.
 * 슬라이더는 끄는 동안 미리보기에만, 놓으면 저장해 위젯에도 반영. 드물게 쓰는 항목은 탭마다 '고급' 접기에 둔다.
 */
type Tab = 'design' | 'display' | 'services' | 'alerts' | 'history' | 'general'
const TABS: Array<[Tab, string]> = [['design', '디자인'], ['display', '표시'], ['services', '서비스'], ['alerts', '알림'], ['history', '기록'], ['general', '일반']]
// 예전 탭 이름으로 열어도 옮겨 간 곳으로 간다.
const TAB_ALIAS: Record<string, Tab> = { accounts: 'services', convenience: 'general', api: 'general' }
const lastTab = () => { try { return localStorage.getItem('settings.tab') } catch { return null } }
const toTab = (v?: string | null): Tab | null => { if (v === 'last') v = lastTab() || 'design'; return v ? (TABS.some(t => t[0] === v) ? v as Tab : TAB_ALIAS[v] || null) : null }
type SizeKey = 'current' | 'flat' | 'small' | 'tall' | 'large'
const SIZES: Array<[SizeKey, string, number, number]> = [['current', '현재 창', 0, 0], ['flat', '납작', 640, 110], ['small', '작게', 300, 220], ['tall', '세로', 300, 640], ['large', '크게', 980, 560]]
const INTERVALS: Array<[number, string]> = [[15, '15초'], [30, '30초'], [60, '1분'], [120, '2분'], [300, '5분']]

interface DetectedApp { id: string; name: string; provider: string; installed?: boolean; running?: boolean }

let tab: Tab = 'design'
let size: SizeKey = 'current'
let sample: 'auto' | 'real' | 'sample' = 'auto'
let state: AppState
let draft: WidgetConfig | null = null // 슬라이더를 끄는 동안의 임시 설정
let root: HTMLElement
let previewFrame = 0
let toastTimer: ReturnType<typeof setTimeout>
let pendingState: AppState | null = null // 입력 중에 온 상태(입력을 마치면 그린다)
let expanded = '' // 서비스 탭에서 펼친 계정
const openAdvanced = new Set<string>() // 펼쳐 둔 '고급' 접기
let detected: DetectedApp[] | null = null
let detecting = false
let addingCustom = false
let addingHome = false
const homeDraft = { provider: 'codex' as 'codex' | 'xai', dir: '', name: '' }
const customDraft = { name: '', p5: '100', pw: '100', color: '#8cbbff' }

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
  // 글자 입력 칸에서 벗어나면 그동안 미뤄 둔 상태를 그린다.
  root.addEventListener('focusout', () => setTimeout(() => { if (pendingState && !typing()) renderSettings(pendingState, true) }, 0))
  // 키보드로 탭 이동(←/→)
  root.addEventListener('keydown', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[role=tab]')
    if (!t || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    const i = TABS.findIndex(x => x[0] === tab), n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0]
    tab = n; renderSettings(state, true)
    root.querySelector<HTMLElement>(`[role=tab][data-tab="${n}"]`)?.focus()
  })
  tab = toTab(initialTab) || 'design'
  renderSettings(initial)
  window.api.onSettingsTab?.(next => { const t = toTab(next); if (t) { tab = t; renderSettings(state, true) } })
  new ResizeObserver(() => { cancelAnimationFrame(previewFrame); previewFrame = requestAnimationFrame(renderPreview) }).observe(container)
}

/** 이름·주소·단축키를 입력하는 중인지. 그동안 새 상태로 다시 그리면 입력이 지워진다. */
function typing() {
  const a = document.activeElement as HTMLElement | null
  return !!a && root.contains(a) && (a.matches('input[type=text],input[type=url],input[type=number],input[type=color],input[type=time],.sc-input'))
}

export function renderSettings(next: AppState, force = false) {
  state = next
  if (!force && (draft || typing())) { if (!draft) pendingState = next; return } // 슬라이더·입력 중에는 다시 그리지 않는다
  pendingState = null
  try { localStorage.setItem('settings.tab', tab) } catch {}
  applyAppearance(config())
  const body0 = root.querySelector('.s-body')
  const scroll = body0?.getAttribute('data-for') === tab ? body0.scrollTop : 0
  updateMarkup(root, `<div class="dashboard settings-root">
    <header class="s-titlebar"><span class="app-symbol" aria-hidden="true"><i></i><i></i><i></i></span><span class="app-title">AI 사용량 설정</span><span class="s-saved">${icon('check')} 바꾸면 바로 저장돼요</span><div class="s-winbtns"><button data-win="minimize" title="최소화" aria-label="최소화"><svg viewBox="0 0 10 10"><path d="M0 5h10"/></svg></button><button data-win="maximize" title="최대화" aria-label="최대화"><svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg></button><button data-win="close" class="close" title="닫기" aria-label="닫기"><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg></button></div></header>
    <div class="s-main">
      <section class="s-preview" aria-label="미리보기">
        <div class="s-preview-bar"><div class="segmented s-sizes" role="group" aria-label="미리보기 크기">${SIZES.map(([k, label]) => `<button data-size="${k}" aria-pressed="${size === k}">${label}</button>`).join('')}</div>
          <div class="segmented s-sample" role="group" aria-label="미리보기 데이터"><button data-sample="real" aria-pressed="${usePreviewSample() ? 'false' : 'true'}" title="지금 내 사용량으로 보기">실제</button><button data-sample="sample" aria-pressed="${usePreviewSample()}" title="예시 데이터로 보기">예시</button></div></div>
        <div class="s-stage" data-stage><div class="s-stage-inner" data-stage-inner></div></div>
        <p class="s-caption" data-caption></p>
      </section>
      <aside class="s-panel">
        <nav class="s-tabs" role="tablist" aria-label="설정 분류">${TABS.map(([k, label]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}" tabindex="${tab === k ? 0 : -1}">${label}</button>`).join('')}</nav>
        <div class="s-body" data-body data-for="${tab}" role="tabpanel"></div>
      </aside>
    </div>
    <div class="toast" role="status" aria-live="polite"></div>
  </div>`)
  const body = root.querySelector<HTMLElement>('[data-body]')!
  const html = tab === 'design' ? designTab(config()) : tab === 'display' ? displayTab(config()) : tab === 'alerts' ? alertsTab(state) : tab === 'history' ? historyTab() : tab === 'general' ? generalTab(state) : servicesTab(state)
  updateMarkup(body, `<div class="s-tab-${tab}">${html}</div>`)
  if (tab === 'history') void drawHistory()
  if (tab === 'services' && detected === null && !detecting) void detectApps()
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
  const warnN = list.filter(u => severity(serviceModel(u), x.warn, x.crit, x.per ? x.per(u.id).showPace : x.showPace)).length
  // 스테이지에 맞게 축소만 한다(확대하지 않음).
  const k = Math.min(1, (stage.clientWidth - 32) / W, (stage.clientHeight - 32) / H)
  updateMarkup(inner, `<div class="pv-win" style="width:${W}px;height:${H}px;transform:scale(${k.toFixed(3)})">
    <div class="dashboard-header"><div class="window-handle"><span class="app-symbol" aria-hidden="true"><i></i><i></i><i></i></span><span class="app-title">AI 사용량</span><span class="header-status"><b>${list.length}개 연결</b>${warnN ? ` · <span class="w">${warnN}개 주의</span>` : ''}</span></div>${W >= 520 ? `<span class="header-clock num" aria-hidden="true">${previewClock()}</span>` : ''}<span class="tool pin on" aria-hidden="true">${icon('pinFill')}</span><span class="tool" aria-hidden="true">${icon('refresh')}</span><span class="tool" aria-hidden="true">${icon('sliders')}</span><span class="tool" aria-hidden="true" title="${DESIGNS.find(d => d[0] === design)![1]}">${icon('menu')}</span></div>
    <div class="dashboard-content">${grid}</div></div>`)
  inner.style.width = `${Math.round(W * k)}px`; inner.style.height = `${Math.round(H * k)}px`
  const cap = root.querySelector<HTMLElement>('[data-caption]')
  if (cap) cap.textContent = `${W}×${H}${size === 'current' ? ' (지금 위젯 크기)' : ''}${k < 1 ? ` · ${Math.round(k * 100)}%로 축소해 표시` : ''}${note}${usePreviewSample() ? ' · 예시 데이터' : ''}`
}

/* ---------- 공통 조각 ---------- */
const presets = [['silk', '실크', '부드럽고 차분하게'], ['aurora', '오로라', '은은하게 흐르는 빛'], ['neon', '네온', '선명한 빛의 대비'], ['segments', '세그먼트', '정교한 리듬감'], ['mono', '모노', '덜어낸 아름다움'], ['spectrum', '스펙트럼', '다채로운 에너지']]
const segment = (key: string, current: string, options: string[][], label: string) => `<div class="segmented" role="group" aria-label="${label}">${options.map(([value, text]) => `<button data-config="${key}" data-value="${value}" aria-pressed="${current === value}">${text}</button>`).join('')}</div>`
const toggle = (key: keyof WidgetConfig, label: string, description: string, value: boolean) => `<label class="setting-row"><span><b>${label}</b>${description ? `<small>${description}</small>` : ''}</span><input class="switch" type="checkbox" data-toggle="${key}" ${value ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span></label>`
const slider = (key: string, label: string, min: number, max: number, value: number, unit: string) => `<label class="slider-setting"><span>${label}<output>${value}${unit}</output></span><input type="range" data-range="${key}" data-unit="${unit}" min="${min}" max="${max}" value="${value}" aria-label="${label}"></label>`
const section = (label: string, inner: string, hint = '') => `<section class="editor-section"><div class="section-label">${label}${hint ? `<span>${hint}</span>` : ''}</div>${inner}</section>`
const hint = (text: string, cls = '') => `<p class="setting-hint ${cls}">${text}</p>`
/** 서비스마다 다른 값을 고르는 단추 묶음(설정 키 대신 data 속성 이름과 계정 ID를 쓴다). */
const segmentRaw = (current: string, options: string[][], attr: string, id: string, label: string) => `<div class="segmented" role="group" aria-label="${label}">${options.map(([value, text]) => `<button ${attr}="${value}" data-id="${id}" aria-pressed="${current === value}">${text}</button>`).join('')}</div>`
const barChoice = (a: AccountConfig) => !a.barColor ? 'brand' : a.barColor === 'green' ? 'green' : 'custom'
const barSwatch = (a: AccountConfig, brand?: string) => /^#[\da-f]{6}$/i.test(a.barColor || '') ? a.barColor! : hex(brand)
/** 경고 배경 처음 값. 켜기·끄기는 따로 두고 모양만 되돌린다. */
const HEAT_DEFAULTS = { warnTintStrength: 30, warnTintSpread: 30, warnTintOrigin: 'edge', warnTintSide: 'top-left' } as const
const isHeatDefault = (c: WidgetConfig) => (c.warnTintStrength ?? 30) === 30 && (c.warnTintSpread ?? 30) === 30 && heatPlacement(c).origin === 'edge' && heatPlacement(c).side === 'top-left'

/** '한쪽'의 방향 고르기: 카드 모양 3×3에서 가장자리 8칸. */
const HEAT_SIDES: Array<[HeatSide | '', string, string]> = [
  ['top-left', '↖', '왼쪽 위'], ['top', '↑', '위'], ['top-right', '↗', '오른쪽 위'],
  ['left', '←', '왼쪽'], ['', '', ''], ['right', '→', '오른쪽'],
  ['bottom-left', '↙', '왼쪽 아래'], ['bottom', '↓', '아래'], ['bottom-right', '↘', '오른쪽 아래']]
function heatSidePicker(current: HeatSide) {
  const name = HEAT_SIDES.find(s => s[0] === current)?.[2] || ''
  return `<div class="heat-side-row"><div class="heat-dir" role="group" aria-label="진하게 칠할 방향">${HEAT_SIDES.map(([v, arrow, label]) => v
    ? `<button data-config="warnTintSide" data-value="${v}" aria-pressed="${current === v}" title="${label}" aria-label="${label}">${arrow}</button>`
    : '<span class="mid" aria-hidden="true"></span>').join('')}</div><small>${name}에서 안쪽으로 진해져요</small></div>`
}

/** 미리보기 제목줄 가운데 시각: 위젯과 같은 현재 시각 */
function previewClock() {
  return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 연속 변화 미리보기 띠: 남은 양 100%(왼쪽) → 0%(오른쪽). */
function colorScale(c: WidgetConfig, warn: number) {
  if (c.colorMode !== 'smooth' || c.colorByUsage === false) return hint(`남은 양이 주의 ${warn}%·위험 ${Math.min(warn, c.critPercent ?? 10)}% 아래로 내려가는 순간 색이 바뀌어요.`)
  const crit = Math.min(warn, c.critPercent ?? 10), top = Math.max(SMOOTH_START, warn + 1)
  const stop = (left: number) => 100 - left
  return `<div class="color-scale" aria-hidden="true" style="background:linear-gradient(90deg,var(--accent) 0%,var(--accent) ${stop(top)}%,var(--warn) ${stop(warn)}%,var(--danger) ${stop(crit)}%,var(--danger) 100%)"></div><div class="color-scale-labels">${[100, top, warn, crit, 0].filter((v, i, a) => a.indexOf(v) === i).filter((v, i, a) => i === 0 || v === 0 || a[i - 1] - v >= 8).map(v => `<span style="left:${stop(v)}%">${v}%</span>`).join('')}</div>`
    + hint(`남은 양 ${top}%까지는 평소 색, 그 아래로 주의 ${warn}%까지 주황으로, 위험 ${crit}%까지 빨강으로 서서히 바뀌어요. 큰 숫자는 주의 기준 아래에서만 색이 바뀌어요.`)
}
const advanced = (id: string, inner: string, label = '고급') => `<details class="s-advanced" data-adv="${id}" ${openAdvanced.has(id) ? 'open' : ''}><summary>${icon('chev')}${label}</summary><div class="s-advanced-body">${inner}</div></details>`

/* ---------- 탭 내용 ---------- */
function designTab(c: WidgetConfig) {
  return section('디자인', `<div class="design-grid">${DESIGNS.map(([id, name, desc]) => `<button class="design-choice" data-config="design" data-value="${id}" aria-pressed="${(c.design || 'rich') === id}"><b>${name}</b><small>${desc}</small></button>`).join('')}</div>`, '위젯 제목줄의 보기 버튼으로도 바꿔요')
    + section('테마', segment('appearance', c.appearance || 'dark', [['light', '라이트'], ['dark', '다크'], ['system', '시스템']], '테마') + hint('시스템은 Windows의 밝은·어두운 모드를 따라가요.'))
    + section('배경', `${state.acrylicSupported === false ? '' : toggle('useAcrylic', '아크릴(흐림)', '창 뒤를 흐리게 비춰요. 끄면 흐림 없이 그대로 비쳐요.', c.useAcrylic !== false)}`
      + slider('opacity', '불투명도', 0, 100, c.opacity ?? 70, '%')
      + hint(`100%면 단색이고, 낮출수록 뒤가 비쳐요. 위젯·팝업·설정 창에 함께 적용돼요.${state.acrylicSupported === false ? ' 이 Windows에서는 아크릴을 쓸 수 없어 흐림 없이 비쳐요.' : ''}`))
    + section('막대 색', `<div class="preset-grid">${presets.map(([id, name, desc]) => `<button class="preset ${(c.barStyle || 'silk') === id ? 'selected' : ''}" data-config="barStyle" data-value="${id}" data-preview="${id}" aria-pressed="${(c.barStyle || 'silk') === id}"><span class="preset-sample"><i></i><i></i></span><span class="preset-name">${name}${(c.barStyle || 'silk') === id ? icon('check') : ''}</span><small>${desc}</small></button>`).join('')}</div>`, '경고색이 있을 때는 경고색이 먼저예요')
    + section('강조색', `<div class="color-swatches">${['#a99bff', '#79c7b2', '#8cbbff', '#f1ae8c', '#f29dc1', '#e3cf83'].map(col => `<button style="--swatch:${col}" data-config="accentColor" data-value="${col}" aria-label="강조색 ${col}" aria-pressed="${c.accentColor === col}">${c.accentColor === col ? icon('check') : ''}</button>`).join('')}<label class="custom-color" title="직접 고르기"><input type="color" value="${hex(c.accentColor)}" aria-label="강조색 직접 고르기" data-color></label></div>`)
    + section('서비스 아이콘', segment('iconStyle', c.iconStyle === 'monochrome' ? 'monochrome' : 'color', [['color', '브랜드 색'], ['monochrome', '단색']], '서비스 아이콘'))
    + section('크기와 간격', slider('fontScale', '글자 크기', 85, 130, c.fontScale || 100, '%') + slider('cardGap', '카드 사이 간격', 4, 16, c.cardGap ?? 6, 'px'))
    + section('움직임', segment('motion', c.motion || 'subtle', [['off', '없음'], ['subtle', '은은하게'], ['expressive', '생동감 있게']], '움직임') + hint('Windows의 애니메이션 효과 끄기 설정도 함께 따라요.'))
}

function displayTab(c: WidgetConfig) {
  const warn = c.warnPercent ?? 20
  const src = new Set(Object.values(c.valueSource || {}))
  const common: ValueSource | '' = src.size === 1 ? [...src][0] as ValueSource : src.size === 0 ? 'weekly' : ''
  return section('큰 숫자', `<div class="segmented" role="group" aria-label="큰 숫자 기준">${(Object.keys(SOURCE_LABEL) as ValueSource[]).map(k => `<button data-source-all="${k}" aria-pressed="${common === k}">${SOURCE_LABEL[k]}</button>`).join('')}</div>${hint(`카드에 크게 보일 한도예요. 카드마다 다르게 하려면 카드의 기준 버튼(주간 ▾)을 누르세요.${common ? '' : ' 지금은 카드마다 다르게 설정되어 있어요.'}`)}`)
    + section('여유가 적을 때', slider('warnPercent', '주의(남은 양)', 5, 50, warn, '%') + slider('critPercent', '위험(남은 양)', 0, warn, Math.min(warn, c.critPercent ?? 10), '%')
      + toggle('colorByUsage', '경고색으로 칠하기', '기준 아래로 내려가면 숫자와 막대를 주황·빨강으로 칠해요.', c.colorByUsage !== false)
      + `<div class="field ${c.colorByUsage === false ? 'is-disabled' : ''}"><span>막대 색이 바뀌는 방식</span>${segment('colorMode', c.colorMode === 'smooth' ? 'smooth' : 'step', [['step', '기준에서 한 번에'], ['smooth', '남은 양에 따라 부드럽게']], '막대 색이 바뀌는 방식')}${colorScale(c, warn)}</div>`
      + toggle('warnTint', '경고 배경 색', '남은 양이 줄수록 카드 배경이 노랑에서 빨강으로 은은하게 바뀌어요. 테두리는 칠하지 않아요.', c.warnTint !== false)
      + `<div class="${c.warnTint === false ? 'is-disabled' : ''}">${slider('warnTintStrength', '세기', 0, 100, c.warnTintStrength ?? 30, '%')}${slider('warnTintSpread', '퍼짐', 0, 100, c.warnTintSpread ?? 30, '%')}
        <div class="field"><span>진한 곳</span>${segment('warnTintOrigin', heatPlacement(c).origin, [['edge', '테두리'], ['center', '가운데'], ['side', '한쪽']], '경고 배경이 진한 곳')}
        ${heatPlacement(c).origin === 'side' ? heatSidePicker(heatPlacement(c).side) : ''}</div>
        <div class="heat-reset-row"><button class="ghost-button" data-heat-reset ${isHeatDefault(c) ? 'disabled' : ''} title="세기 30% · 퍼짐 30% · 테두리">${icon('refresh')}기본값으로</button></div></div>`
      + toggle('sortLowFirst', '여유가 적은 서비스를 앞으로', '', !!c.sortLowFirst)
      + hint('남은 양이 기준보다 많아도, 지금 속도면 리셋보다 한참 먼저 바닥날 것 같으면 \'속도 주의\'로 알려요.'))
    + section('보여 줄 정보', displayTable(c), '맨 윗줄은 모든 서비스에 한 번에')
    + section('창', toggle('alwaysOnTop', '항상 위에 표시', '다른 창에 가려지지 않아요.', c.alwaysOnTop !== false)
      + (state.dockSupported === false ? '' : `<button class="secondary-button" data-action="dock">${icon('dock')}작업 표시줄에 붙이기</button>${hint('위젯 제목줄을 화면 아래 작업 표시줄로 끌어도 붙어요.')}`))
}

/** 서비스×항목 표. 맨 윗줄 '모든 서비스'는 일괄 변경(값이 섞이면 '일부'). 카드 우클릭 메뉴에서도 바꿀 수 있다. */
function displayTable(c: WidgetConfig) {
  const accs = state.accounts.filter(a => a.enabled && !a.hidden), ids = accs.map(a => a.id)
  const head = `<div class="dt-row dt-head"><span></span>${DISPLAY_KEYS.map(([, label, tip]) => `<span title="${tip}">${label}</span>`).join('')}</div>`
  const all = `<div class="dt-row dt-all"><span><b>모든 서비스</b></span>${DISPLAY_KEYS.map(([k, label]) => { const s = displaySummary(c, ids, k); return `<label class="dt-cell"><input type="checkbox" data-dall="${k}" ${s === 'on' ? 'checked' : ''} data-mixed="${s === 'mixed'}" aria-label="모든 서비스 ${label}"></label>` }).join('')}</div>`
  const rows = accs.map(a => { const v = displayOf(c, a.id); return `<div class="dt-row"><span class="dt-name">${renderAiIcon(a.provider, a.name, c.iconStyle, 18)}<span>${escapeText(a.name)}</span></span>${DISPLAY_KEYS.map(([k, label]) => `<label class="dt-cell"><input type="checkbox" data-d1="${k}" data-id="${escapeText(a.id)}" ${v[k] ? 'checked' : ''} aria-label="${escapeText(a.name)} ${label}"></label>`).join('')}</div>` }).join('')
  return `<div class="dt">${head}${all}${rows}</div>${hint('쓴 양으로: 끄면 남은 양. 예상 시간: 페이스 눈금(고르게 썼다면 지금 남아 있어야 할 위치)·속도 칩·소진 예상 문구. 리셋 시간: 리셋까지 남은 시간과 시각. 카드를 우클릭해도 바꿀 수 있어요.')}`
}

const visibilityOf = (a: AccountConfig) => a.hidden ? 'none' : a.hiddenInDock ? 'window' : 'all'
/** 바로 열기 한 줄: 아이콘·이름·단축키, 아래에 무엇을 여는지(자동/직접), 오른쪽에 고르기·되돌리기. */
function openRow(o: { ic: string; title: string; keys: string; kind: string; own?: string; auto?: string; autoText: string; missing: string; pick: string; reset: string; id: string; resetTitle: string }) {
  // 경로만 코드 글꼴(긴 경로는 앞쪽을 줄여 끝부분이 보이게), 앱 이름·'홈 폴더'는 보통 글꼴
  const val = (v: string) => `<span class="sd-path ${/[\\/]/.test(v) ? '' : 'plain'}">${escapeText(v)}</span>`
  const value = o.own ? `<span class="sd-chip own">직접</span>${val(o.own)}`
    : o.auto ? `<span class="sd-chip">${o.kind === 'cwd' ? '기본' : '자동'}</span>${val(o.auto)}`
    : `<span class="sd-chip warn">못 찾음</span><span class="sd-path muted">${o.missing}</span>`
  return `<div class="sd-open" title="${escapeText(o.own || o.auto || '')}"><span class="sd-open-ic">${icon(o.ic)}</span>
    <div class="sd-open-main"><div class="sd-open-head"><b>${o.title}</b>${o.keys ? `<span class="sd-keys">${o.keys}</span>` : ''}</div><div class="sd-open-val">${value}</div></div>
    <div class="sd-open-act"><button class="icon-btn" ${o.pick}="${o.kind}" data-id="${o.id}" title="직접 고르기" aria-label="${o.title} 직접 고르기">${icon(o.kind === 'cwd' ? 'folder' : 'pencil')}</button>${o.own ? `<button class="icon-btn" ${o.reset}="${o.kind}" data-id="${o.id}" title="${o.resetTitle}" aria-label="${o.resetTitle}">${icon('undo')}</button>` : ''}</div></div>`
}
function launchRow(a: AccountConfig, s: AppState, kind: 'cli' | 'app') {
  return openRow({ ic: kind === 'cli' ? 'terminal' : 'app', title: kind === 'cli' ? 'CLI 열기' : '앱 열기', keys: kind === 'cli' ? '<kbd>Ctrl</kbd>+두 번 클릭' : '<kbd>Shift</kbd>+두 번 클릭',
    kind, own: kind === 'cli' ? a.launchCli : a.launchApp, auto: s.launchers?.[a.id]?.[kind], autoText: '', missing: '이 PC에서 찾지 못했어요 · 직접 골라 주세요',
    pick: 'data-launch-pick', reset: 'data-launch-auto', id: escapeText(a.id), resetTitle: '자동으로 찾기' })
}
/** CLI를 열 때 시작 폴더(기본 홈 폴더). */
function cwdRow(a: AccountConfig) {
  return openRow({ ic: 'folder', title: 'CLI 시작 폴더', keys: '', kind: 'cwd', own: a.launchCwd, auto: '홈 폴더', autoText: '', missing: '',
    pick: 'data-cwd-pick', reset: 'data-cwd-reset', id: escapeText(a.id), resetTitle: '홈 폴더로' })
}

function statusOf(a: AccountConfig, s: AppState): [string, string] {
  const u = s.usages.find(u => u.id === a.id)
  if (!a.enabled) return ['조회 꺼짐', 'off']
  if (a.hidden) return ['숨김', 'off']
  if (a.provider === 'custom') return ['직접 입력', 'ok']
  if (u?.errorMessage && /로그인.*만료/.test(u.errorMessage)) return [u.status === 'stale' ? '로그인 만료 · 마지막 값' : '로그인 만료', 'warn']
  return u?.status === 'ready' ? (u.isEstimated ? ['추정값', 'warn'] : ['연결됨', 'ok']) : u?.status === 'stale' ? ['갱신 지연', 'warn'] : u?.status === 'loading' ? ['확인 중', 'off'] : ['연결 안 됨', 'bad']
}
function servicesTab(s: AppState) {
  const rows = s.accounts.map((a, index) => {
    const u = s.usages.find(u => u.id === a.id), id = escapeText(a.id), name = escapeText(a.name)
    const [status, tone] = statusOf(a, s), open = expanded === a.id
    const sub = [status, a.orgUuid && u?.tier ? escapeText(u.tier) : ''].filter(Boolean).join(' · ')
    const scopedNames = u?.scopedQuotas?.map(x => x.label) || u?.scopedHidden || []
    const vis = visibilityOf(a)
    const visNote = vis === 'all' ? '위젯 창과 작업 표시줄 모두에 보여요' : vis === 'window' ? '작업 표시줄에 붙였을 때는 빼요' : '어디에도 안 보여요(조회는 계속해요)'
    // 펼친 서비스: 표시 / 바로 열기 / 순서·관리 세 묶음
    const detail = open ? `<div class="svc-detail" id="svc-detail-${id}">
        <div class="sd-group">
          <div class="sd-title">표시</div>
          <label class="sd-row"><span class="sd-label"><b>이름</b></span><input type="text" class="text-input sd-input" data-name-input="${id}" value="${name}" maxlength="60" aria-label="${name} 이름"></label>
          <div class="sd-row stack"><span class="sd-label"><b>평소 색</b><small>여유가 있을 때 그래프에 쓰는 색</small></span><div class="color-choice">${segmentRaw(barChoice(a), [['brand', '서비스 색'], ['green', '초록'], ['custom', '직접']], `data-barcolor`, id, `${name} 평소 색`)}<label class="color-dot ${barChoice(a) === 'custom' ? '' : 'muted'}" title="색 고르기" style="--swatch:${barSwatch(a, u?.brandColor)}"><input type="color" data-barcolor-pick="${id}" value="${barSwatch(a, u?.brandColor)}" aria-label="${name} 평소 색 직접 고르기"></label></div></div>
          <div class="sd-row stack"><span class="sd-label"><b>보일 곳</b><small>${visNote}</small></span><div class="segmented" role="group" aria-label="${name} 보일 곳">${[['all', '모두', '위젯 창과 작업 표시줄 모두에 보여요'], ['window', '위젯 창만', '작업 표시줄에 붙였을 때는 빼요'], ['none', '숨김', '어디에도 보이지 않아요(조회는 계속해요)']].filter(([v]) => v !== 'window' || s.dockSupported !== false).map(([v, t, d]) => `<button data-visibility="${v}" data-id="${id}" aria-pressed="${vis === v}" title="${d}">${t}</button>`).join('')}</div></div>
          ${scopedNames.length ? `<label class="sd-row"><span class="sd-label"><b>${escapeText(scopedNames.join('·'))} 한도</b><small>모델 전용 주간 한도도 카드에</small></span><input class="switch" type="checkbox" data-scoped="${id}" ${a.showScoped === false ? '' : 'checked'}><span class="switch-track" aria-hidden="true"></span></label>` : ''}
        </div>
        <div class="sd-group">
          <div class="sd-title">바로 열기</div>
          ${launchRow(a, s, 'cli')}${cwdRow(a)}${launchRow(a, s, 'app')}
        </div>
        <div class="sd-foot">
          <div class="sd-order" role="group" aria-label="순서"><button class="icon-btn" data-order="up" data-id="${id}" ${index === 0 ? 'disabled' : ''} title="앞으로" aria-label="앞으로">${icon('up')}</button><button class="icon-btn" data-order="down" data-id="${id}" ${index === s.accounts.length - 1 ? 'disabled' : ''} title="뒤로" aria-label="뒤로">${icon('down')}</button><span>순서</span></div>
          <button class="text-btn danger" data-remove="${id}">${icon('trash')}목록에서 빼기</button>
        </div>
      </div>` : ''
    return `<div class="svc-item ${open ? 'open' : ''}" data-svc="${id}">
      <div class="svc-row"><button class="svc-head" data-expand="${id}" aria-expanded="${open}" aria-controls="svc-detail-${id}">${renderAiIcon(a.provider, a.name, s.config.iconStyle, 28)}<span class="svc-text"><b>${name}</b><small><i class="dot ${tone}"></i>${sub}</small></span>${icon('chev')}</button>
      <label class="mini-toggle" title="${a.enabled ? '사용량 조회 중' : '조회 꺼짐'}"><input type="checkbox" class="switch" data-enabled="${id}" aria-label="${name} 사용량 조회" ${a.enabled ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span></label></div>
      ${detail}</div>`
  }).join('')
  const added = new Set(s.accounts.map(a => a.id))
  const found = (detected || []).map(app => `<div class="found-row">${renderAiIcon(app.provider, app.name, s.config.iconStyle, 22)}<span class="svc-text"><b>${escapeText(app.name)}</b><small>${app.running ? '실행 중' : app.installed ? '설치됨' : '찾을 수 있음'}</small></span>${added.has(app.id) ? '<span class="pill">추가됨</span>' : `<button class="ghost-button accent" data-add-app="${escapeText(app.id)}">${icon('plus')}추가</button>`}</div>`).join('')
  const custom = addingCustom ? `<div class="custom-form">
      <label class="field"><span>이름</span><input type="text" class="text-input" data-custom="name" maxlength="60" placeholder="예: 회사 Claude" value="${escapeText(customDraft.name)}"></label>
      <div class="field-row"><label class="field"><span>5시간 남은 양(%)</span><input type="number" class="text-input" data-custom="p5" min="0" max="100" value="${escapeText(customDraft.p5)}"></label><label class="field"><span>주간 남은 양(%)</span><input type="number" class="text-input" data-custom="pw" min="0" max="100" value="${escapeText(customDraft.pw)}"></label><label class="field narrow"><span>색</span><input type="color" class="color-input" data-custom="color" value="${hex(customDraft.color)}"></label></div>
      <div class="svc-actions"><button class="primary-button" data-custom-save>추가</button><button class="ghost-button" data-custom-cancel>취소</button></div>
    </div>` : `<button class="secondary-button" data-custom-open>${icon('plus')}숫자를 직접 넣는 카드 추가</button>`
  const env = homeDraft.provider === 'codex' ? 'CODEX_HOME' : 'GROK_HOME', cli = homeDraft.provider === 'codex' ? 'codex' : 'grok'
  const home = addingHome ? `<div class="custom-form">
      <div class="field"><span>서비스</span><div class="segmented" role="group" aria-label="서비스">${([['codex', 'Codex'], ['xai', 'Grok']] as const).map(([v, t]) => `<button data-home-provider="${v}" aria-pressed="${homeDraft.provider === v}">${t}</button>`).join('')}</div></div>
      <div class="field"><span>로그인 폴더</span><div class="field-inline"><input type="text" class="text-input" data-home-dir readonly placeholder="폴더를 고르세요" value="${escapeText(homeDraft.dir)}"><button class="ghost-button" data-home-pick>폴더 고르기</button></div></div>
      <label class="field"><span>이름(선택)</span><input type="text" class="text-input" data-home-name maxlength="60" placeholder="예: ${homeDraft.provider === 'codex' ? 'Codex 회사' : 'Grok 두 번째'}" value="${escapeText(homeDraft.name)}"></label>
      ${hint(`먼저 그 폴더로 로그인해 두세요. 명령 프롬프트에서 <code>set ${env}=폴더 경로</code> 다음에 <code>${cli} login</code>을 실행하면 돼요. 평소 쓰는 계정과 따로 로그인돼요.`)}
      <div class="svc-actions"><button class="primary-button" data-home-save>추가</button><button class="ghost-button" data-home-cancel>취소</button></div>
    </div>` : `<button class="secondary-button" data-home-open>${icon('plus')}다른 로그인 폴더의 계정 추가 (Codex·Grok)</button>`
  return section('서비스', `<div class="svc-list">${rows || hint('아직 서비스가 없어요. 아래에서 추가하세요.')}</div>`, '눌러서 이름·보일 곳·순서를 바꿔요')
    + hint('스위치를 끄면 그 서비스의 사용량을 조회하지 않아요. 위젯에서 카드를 끌어 순서를 바꿀 수도 있어요.')
    + toggle('hideDisconnected', '연결 안 된 서비스 숨기기', '한 번도 연결된 적 없는 카드를 위젯에서 빼요. 한 번이라도 연결됐던 카드는 끊겨도 마지막 값과 ! 표시로 계속 보여 줘요.', !!s.config.hideDisconnected)
    + section('서비스 추가', `<div class="found-list">${detecting ? hint('이 PC의 로그인을 찾는 중…') : found || hint('찾은 앱이 없어요. Claude·Codex·Antigravity·Grok 앱이나 CLI에 로그인한 뒤 다시 찾아 보세요.')}</div>${home}${custom}`, `<button class="link-button" data-redetect ${detecting ? 'disabled' : ''}>다시 찾기</button>`)
    + advanced('services', `<button class="secondary-button danger" data-reset-defaults>기본 서비스 목록으로 되돌리기</button>${hint('직접 추가하거나 뺀 카드를 지우고, 이 PC에서 찾은 서비스로 목록을 새로 만들어요.')}`)
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
  return section('Windows 알림', toggle('notifyEnabled', '알림 받기', '아래 상황이 되면 Windows 알림으로 알려 줘요.', on)
      + `<button class="secondary-button" data-test-notify>${icon('bell')}테스트 알림 보내기</button>${hint('알림이 안 보이면 Windows 설정의 알림이나 방해 금지 모드를 확인하세요. 알림을 누르면 위젯이 나타나요.')}`)
    + `<div class="${on ? '' : 'is-disabled'}">`
    + section('알릴 때', toggle('notifyLow', '여유가 적을 때', `남은 양이 주의 ${warn}%·위험 ${crit}%에 처음 닿을 때 한 번씩 (기준은 표시 탭에서 바꿔요)`, c.notifyLow !== false)
      + toggle('notifyPace', '리셋 전에 바닥날 것 같을 때', '지금 속도가 이어지면 리셋보다 한참 먼저 소진될 때', c.notifyPace !== false)
      + toggle('notifyReset', '한도가 다시 채워졌을 때', '빠듯했던 한도가 리셋됐을 때', c.notifyReset === true)
      + toggle('notifyUnused', '주간 여유가 많이 남았을 때', '주간 리셋이 24시간 안인데 40% 넘게 남았을 때', c.notifyUnused !== false)
      + hint('같은 리셋 주기 안에서는 종류마다 한 번만 알려요. 앱을 다시 켜도 반복하지 않고, 갱신이 늦어진 값으로는 알리지 않아요.'))
    + section('쉬는 시간', (() => { const q = c.notifyQuiet || { enabled: false, start: '23:00', end: '08:00' }
        return `<label class="setting-row"><span><b>알림 쉬는 시간</b><small>이 시간에는 사용량 알림을 보내지 않아요. 지난 알림을 나중에 몰아 보내지도 않아요.</small></span><input class="switch" type="checkbox" data-quiet-on ${q.enabled ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span></label>
        <div class="field-row quiet-times ${q.enabled ? '' : 'is-disabled'}"><label class="field"><span>시작</span><input type="time" class="text-input" data-quiet="start" value="${q.start}"></label><label class="field"><span>끝</span><input type="time" class="text-input" data-quiet="end" value="${q.end}"></label></div>` })())
    + section('서비스별', rows ? `<div class="alert-table">${rows}</div>` : hint('조회 중인 서비스가 없어요.'), '체크한 한도만 알려요')
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
  if (!list.length) return section('사용 기록', hint('아직 기록이 없어요. 사용량을 조회할 때마다 이 PC에 쌓이고 30일 동안 보관해요.'))
  return section('서비스', `<div class="chip-row">${list.map(u => `<button class="chip-btn" data-hist="${escapeText(u.id)}" aria-pressed="${u.id === histId}">${renderAiIcon(u.provider, u.name, state.config.iconStyle, 16)}${escapeText(u.name)}</button>`).join('')}</div>`)
    + section('기간', `<div class="segmented" role="group" aria-label="기간"><button data-hrange="day" aria-pressed="${histRange === 'day'}">최근 24시간</button><button data-hrange="week" aria-pressed="${histRange === 'week'}">최근 7일</button></div>`)
    + `<section class="editor-section"><div class="hist-chart" data-hist-chart data-keep>${hint('불러오는 중…')}</div>${hint(`남은 양(%)의 흐름이에요. 사용량을 조회할 때마다 이 PC에만 기록하고 30일 동안 보관해요.${usePreviewSample() ? ' 지금은 예시 기록이에요.' : ''}`)}</section>`
}
let histSeq = 0
async function drawHistory() {
  const box = root.querySelector<HTMLElement>('[data-hist-chart]'); if (!box || !histId) return
  const seq = ++histSeq
  const now = Date.now(), span = histRange === 'day' ? 86400e3 : 7 * 86400e3, from = now - span
  const u = historyServices().find(x => x.id === histId)!
  let pts: HistoryPoint[]
  try { pts = usePreviewSample() ? downsample(sampleHistory()[histId] || [], from, now, 200) : await window.api.getHistory(histId, from, now, 200) }
  catch { if (seq === histSeq) box.innerHTML = hint('기록을 불러오지 못했어요.'); return }
  if (seq !== histSeq || !box.isConnected) return
  if (pts.length < 2) { box.innerHTML = hint('이 기간에는 기록이 아직 충분하지 않아요.'); return }
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
    + `</svg><div class="hist-legend">${l5 ? `<span><i style="background:${brand}"></i>${u.primaryKind === 'monthly' ? '월간' : '5시간'} · 최저 ${lows(1)}%</span>` : ''}${lw ? `<span><i class="dash" style="border-color:${weekColor}"></i>주간 · 최저 ${lows(2)}%</span>` : ''}</div>`
}

const SHORTCUT_DEFAULTS = { toggle: 'Ctrl+Alt+U', lock: 'Ctrl+Alt+L', cycle: 'Ctrl+Alt+D' }
type ShortcutKey = keyof typeof SHORTCUT_DEFAULTS
function generalTab(s: AppState) {
  const c = s.config, sc = { ...SHORTCUT_DEFAULTS, ...c.shortcuts }, errors = s.shortcutErrors || []
  const saved = Object.keys(c.layoutsByMonitor || {}).length
  const interval = INTERVALS.some(i => i[0] === c.refreshIntervalSec) ? c.refreshIntervalSec : 60
  const row = (k: ShortcutKey, label: string) => `<div class="sc-row"><span class="sc-label">${label}</span><input class="sc-input" data-shortcut="${k}" readonly value="${escapeText(sc[k] || '')}" placeholder="꺼짐" aria-label="${label} 단축키(누른 뒤 새 조합 입력)"><button class="tool" data-sc-clear="${k}" title="끄기" aria-label="${label} 단축키 끄기">${icon('close')}</button><button class="sc-reset" data-sc-default="${k}" ${sc[k] === SHORTCUT_DEFAULTS[k] ? 'disabled' : ''}>기본값</button></div>`
  return section('시작과 갱신', toggle('openAtLogin', 'Windows를 켤 때 함께 시작', '', c.openAtLogin !== false)
      + `<div class="field"><span>사용량 확인 간격</span><div class="segmented" role="group" aria-label="사용량 확인 간격">${INTERVALS.map(([v, t]) => `<button data-interval="${v}" aria-pressed="${interval === v}">${t}</button>`).join('')}</div></div>`
      + hint('간격이 짧으면 숫자가 빨리 바뀌지만 서비스의 조회 제한에 걸릴 수 있어요. Claude는 간격과 관계없이 2분에 한 번만 물어봐요.'))
    + section('트레이', toggle('trayShowNumber', '트레이 아이콘에 남은 % 표시', '가장 빠듯한 서비스의 남은 양을 보여 주고, 주의·위험이면 색이 바뀌어요. 위젯을 숨겨도 볼 수 있어요.', c.trayShowNumber !== false))
    + section('클릭 통과', toggle('clickThrough', '위젯 클릭 통과 잠금', '위젯을 눌러도 뒤의 창이 눌려요. 마우스로는 풀 수 없으니 단축키나 트레이 메뉴로 푸세요. (작업 표시줄에 붙인 상태에서는 쓰지 않아요)', !!c.clickThrough))
    + section('단축키', `<div class="sc-list">${row('toggle', '위젯 보이기·숨기기')}${row('lock', '클릭 통과 잠금·풀기')}${row('cycle', '다음 디자인')}</div>
      ${hint('칸을 누르고 새 조합(Ctrl·Alt·Shift + 글자)을 누르세요. Esc는 취소, Backspace는 끄기예요.')}
      ${errors.length ? hint(`등록하지 못한 단축키: ${escapeText(errors.join(', '))} — 다른 앱이 쓰고 있을 수 있어요. 다른 조합으로 바꿔 주세요.`, 'warn-text') : ''}`)
    + advanced('general', section('모니터 구성별 배치', toggle('rememberPerMonitor', '모니터 구성마다 기억', '모니터를 연결하거나 뺄 때, 그 구성에서 쓰던 위치·크기·디자인으로 돌아가요.', c.rememberPerMonitor !== false)
        + `${hint(`저장된 구성 ${saved}개`)}${saved ? '<button class="secondary-button" data-clear-layouts>저장된 구성 모두 지우기</button>' : ''}`)
      + (s.dockSupported === false ? '' : section('작업 표시줄에 붙였을 때', hint('한 번 누르면 상세 보기, 두 번 누르면 그 카드만 보는 집중 모드가 켜지고 꺼져요.')
        + toggle('showCardBackground', '서비스 칸 배경', '끄면 작업 표시줄과 한 몸처럼 투명해 보여요.', c.showCardBackground !== false)
        + slider('verticalOffsetPx', '세로 위치 미세 조정', -20, 20, c.verticalOffsetPx ?? 0, 'px')
        + hint('좌우 위치는 작업 표시줄 안에서 끌어 옮겨요.')))
      + section('설정 백업', `<div class="svc-actions"><button class="ghost-button" data-backup="export">${icon('arrow')}파일로 내보내기</button><button class="ghost-button" data-backup="import">${icon('plus')}파일에서 불러오기</button></div>${hint('화면·알림 설정과 카드 목록을 파일 하나로 저장해요. 로그인 정보는 담지 않아요. 다른 PC로 옮기거나 다시 설치할 때 쓰세요.')}`)
      + section('외부 디스플레이로 보내기', toggle('apiPushEnabled', '사용량 보내기', '확인할 때마다 아래 주소로 사용량을 HTTP POST로 보내요(책상 위 작은 화면 등).', !!c.apiPushEnabled)
        + `<label class="field"><span>받을 주소</span><input type="url" class="text-input" data-api-endpoint value="${escapeText(c.apiEndpoint || 'http://localhost:8080/api/usage')}" spellcheck="false"></label>
        <label class="field"><span>화면 번호</span><input type="number" class="text-input short" data-api-screen min="1" step="1" value="${c.apiScreen ?? 1}"></label>`), '고급 설정')
    + section('정보', `<p class="about">AI 사용량 위젯${s.version ? ` <b>${escapeText(s.version)}</b>` : ''}<span class="update-line ${updateTone(s)}">${updateText(s)}</span></p>`
      + (s.update && s.update.status !== 'unsupported' || s.preview ? `<label class="field"><span>자동 업데이트 설치 시각</span>${updateHourSelect(s)}</label>${hint('새 버전은 미리 받아 두고 이 시각(PC 시계 기준)에 설치하고 다시 시작해요. PC가 꺼져 있거나 잠자기였으면 2시간 안에 켜질 때 설치하고, 아니면 다음 날로 미뤄요.')}` : '')
      + `<button class="secondary-button" data-open-about>${icon('refresh')}정보·업데이트 열기</button>`
      + (s.guideAvailable ? `<button class="secondary-button" data-open-guide>${icon('book')}사용 설명서 열기</button>` : ''))
}
function updateText(s: AppState) {
  const u = s.update
  if (!u || u.status === 'unsupported' || u.status === 'idle') return ''
  const at = u.checkedAt ? new Date(u.checkedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : ''
  return u.status === 'checking' ? '새 버전 확인 중…'
    : u.status === 'downloading' ? `새 버전 ${escapeText(u.version || '')} 받는 중 ${u.percent ?? 0}%`
    : u.status === 'ready' ? `새 버전 ${escapeText(u.version || '')} 준비됨`
    : u.status === 'latest' ? `최신 버전이에요${at ? ` · ${at} 확인` : ''}`
    : `${escapeText(u.message || '업데이트를 확인하지 못했어요')}${at ? ` · ${at}` : ''}`
}
const updateTone = (s: AppState) => s.update?.status === 'ready' ? 'good' : s.update?.status === 'error' ? 'bad' : ''

function shortcutFromEvent(e: KeyboardEvent): string | null {
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]
  // 한글 입력 상태에서는 e.key가 자모로 오므로 글쇠 위치(e.code)로 읽는다.
  const code = /^Key([A-Z])$/.exec(e.code)?.[1] || /^Digit(\d)$/.exec(e.code)?.[1]
  const k = code || (e.key.length === 1 ? e.key.toUpperCase() : /^F\d{1,2}$/.test(e.key) ? e.key : null)
  // 글자 단독은 다른 앱의 입력을 막으므로 Ctrl 또는 Alt를 반드시 함께 쓴다.
  if (!k || !/^[A-Z0-9]$|^F\d{1,2}$/.test(k) || !(e.ctrlKey || e.altKey)) return null
  return [...mods, k].join('+')
}

/* ---------- 이벤트 ---------- */
function notify(message: string) {
  const toast = root.querySelector<HTMLElement>('.toast'); if (!toast) return
  clearTimeout(toastTimer); toast.textContent = message; toast.classList.add('visible')
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2400)
}
async function update(patch: Partial<WidgetConfig>) {
  try { draft = null; const next = await window.api.updateConfig(patch); renderSettings(next, true) }
  catch { notify('설정을 저장하지 못했어요. 다시 시도해 주세요.') }
}
async function detectApps() {
  detecting = true
  if (tab === 'services') renderSettings(state, true)
  try { detected = await window.api.detectLocalApps() as DetectedApp[] } catch { detected = [] }
  detecting = false
  if (tab === 'services' && !typing()) renderSettings(state, true)
}
const run = (p: Promise<unknown>, fail: string) => { void p.catch(() => notify(fail)) }

function bindEvents() {
  root.querySelectorAll<HTMLElement>('[data-tab]').forEach(el => el.onclick = () => { tab = el.dataset.tab as Tab; renderSettings(state, true) })
  root.querySelectorAll<HTMLElement>('[data-size]').forEach(el => el.onclick = () => { size = el.dataset.size as SizeKey; renderSettings(state, true) })
  root.querySelectorAll<HTMLElement>('[data-sample]').forEach(el => el.onclick = () => { sample = el.dataset.sample as 'real' | 'sample'; renderSettings(state, true) })
  const body = root.querySelector<HTMLElement>('[data-body]')!
  // 같은 요소가 다시 그려져도 남으므로(updateMarkup) addEventListener를 쓰면 동작이 쌓인다. 항상 덮어쓴다.
  const onClickOf = (sel: string, fn: (e: MouseEvent) => unknown) => { const el = body.querySelector<HTMLElement>(sel); if (el) el.onclick = fn }
  body.querySelectorAll<HTMLDetailsElement>('[data-adv]').forEach(el => el.ontoggle = () => { if (el.open) openAdvanced.add(el.dataset.adv!); else openAdvanced.delete(el.dataset.adv!) })
  body.querySelectorAll<HTMLElement>('[data-config]').forEach(el => el.onclick = () => { void update({ [el.dataset.config!]: el.dataset.value }) })
  body.querySelectorAll<HTMLElement>('[data-heat-reset]').forEach(el => el.onclick = () => { void update({ ...HEAT_DEFAULTS }); notify('경고 배경을 기본값으로 되돌렸어요.') })
  body.querySelectorAll<HTMLSelectElement>('[data-update-hour]').forEach(el => el.onchange = () => { void update({ updateHour: Number(el.value) }) })
  body.querySelectorAll<HTMLInputElement>('[data-toggle]').forEach(el => el.onchange = () => { void update({ [el.dataset.toggle!]: el.checked }) })
  body.querySelectorAll<HTMLInputElement>('[data-dall]').forEach(el => { el.indeterminate = el.dataset.mixed === 'true'; el.onchange = () => { void update(setDisplayAll(config(), el.dataset.dall as DisplayKey, el.checked)) } })
  body.querySelectorAll<HTMLInputElement>('[data-d1]').forEach(el => el.onchange = () => { void update(setDisplay(config(), el.dataset.id!, el.dataset.d1 as DisplayKey, el.checked)) })
  const quiet = () => config().notifyQuiet || { enabled: false, start: '23:00', end: '08:00' }
  const quietOn = body.querySelector<HTMLInputElement>('[data-quiet-on]')
  if (quietOn) quietOn.onchange = () => { void update({ notifyQuiet: { ...quiet(), enabled: quietOn.checked } }) }
  body.querySelectorAll<HTMLInputElement>('[data-quiet]').forEach(el => el.onchange = () => { if (/^\d\d:\d\d$/.test(el.value)) void update({ notifyQuiet: { ...quiet(), [el.dataset.quiet!]: el.value } }) })
  body.querySelectorAll<HTMLElement>('[data-interval]').forEach(el => el.onclick = () => { void update({ refreshIntervalSec: Number(el.dataset.interval) }) })
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
    // 같은 값에서 놓으면 change가 오지 않는다. 임시 값이 남으면 창이 새 상태를 따라가지 못하므로 정리한다.
    el.onpointerup = el.onblur = () => setTimeout(() => { if (draft && draft[el.dataset.range as keyof WidgetConfig] === state.config[el.dataset.range as keyof WidgetConfig]) { draft = null; renderSettings(state, true) } }, 0)
  })
  const colorInput = body.querySelector<HTMLInputElement>('[data-color]')
  if (colorInput) colorInput.onchange = () => { void update({ accentColor: colorInput.value }) }
  body.querySelectorAll<HTMLElement>('[data-action="dock"]').forEach(el => el.onclick = () => { void update({ placementMode: 'docked' }) })

  // 단축키
  body.querySelectorAll<HTMLInputElement>('[data-shortcut]').forEach(el => {
    el.onkeydown = e => {
      if (e.key === 'Tab') return // 다음 칸으로 이동(키보드 사용자)
      e.preventDefault()
      const k = el.dataset.shortcut as ShortcutKey, cur = { ...SHORTCUT_DEFAULTS, ...config().shortcuts }
      if (e.key === 'Escape') { el.blur(); return }
      if (e.key === 'Backspace' || e.key === 'Delete') { el.blur(); void update({ shortcuts: { ...cur, [k]: '' } }); return }
      const accel = shortcutFromEvent(e)
      if (!accel) { if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) el.value = 'Ctrl 또는 Alt와 함께 눌러 주세요'; return }
      if (Object.entries(cur).some(([other, v]) => other !== k && v === accel)) { notify('다른 동작에 이미 쓰는 조합이에요.'); return }
      el.blur(); void update({ shortcuts: { ...cur, [k]: accel } })
    }
    el.onblur = () => { el.value = ({ ...SHORTCUT_DEFAULTS, ...config().shortcuts })[el.dataset.shortcut as ShortcutKey] || '' }
  })
  body.querySelectorAll<HTMLElement>('[data-sc-clear]').forEach(el => el.onclick = () => { void update({ shortcuts: { ...SHORTCUT_DEFAULTS, ...config().shortcuts, [el.dataset.scClear!]: '' } }) })
  body.querySelectorAll<HTMLElement>('[data-sc-default]').forEach(el => el.onclick = () => { const k = el.dataset.scDefault as ShortcutKey; void update({ shortcuts: { ...SHORTCUT_DEFAULTS, ...config().shortcuts, [k]: SHORTCUT_DEFAULTS[k] } }) })
  onClickOf('[data-clear-layouts]', () => { void update({ layoutsByMonitor: {} }) })

  // 외부 디스플레이: 입력을 마칠 때(Enter·포커스 이동)만 저장한다.
  const ep = body.querySelector<HTMLInputElement>('[data-api-endpoint]')
  if (ep) ep.onchange = () => { const v = ep.value.trim(); if (/^https?:\/\/\S+$/i.test(v)) void update({ apiEndpoint: v }); else { notify('http:// 또는 https://로 시작하는 주소를 넣어 주세요.'); ep.value = state.config.apiEndpoint || 'http://localhost:8080/api/usage' } }
  const scr = body.querySelector<HTMLInputElement>('[data-api-screen]')
  if (scr) scr.onchange = () => { const v = parseInt(scr.value, 10); if (v >= 1) void update({ apiScreen: v }); else scr.value = String(state.config.apiScreen ?? 1) }
  onClickOf('[data-open-about]', () => { void window.api.openAbout() })
  onClickOf('[data-update-check]', () => run(window.api.checkUpdate(), '업데이트를 확인하지 못했어요.'))
  onClickOf('[data-update-install]', () => run(window.api.installUpdate(), '업데이트를 설치하지 못했어요.'))
  body.querySelectorAll<HTMLElement>('[data-backup]').forEach(el => el.onclick = async () => {
    try {
      const r = el.dataset.backup === 'export' ? await window.api.exportSettings() : await window.api.importSettings()
      if (r.message) notify(r.message)
    } catch { notify(el.dataset.backup === 'export' ? '내보내지 못했어요.' : '불러오지 못했어요.') }
  })
  onClickOf('[data-open-guide]', () => run(window.api.openGuide().then(ok => { if (!ok) notify('사용 설명서를 찾지 못했어요.') }), '사용 설명서를 열지 못했어요.'))

  // 기록
  body.querySelectorAll<HTMLElement>('[data-hist]').forEach(el => el.onclick = () => { histId = el.dataset.hist!; renderSettings(state, true) })
  body.querySelectorAll<HTMLElement>('[data-hrange]').forEach(el => el.onclick = () => { histRange = el.dataset.hrange as 'day' | 'week'; renderSettings(state, true) })

  // 알림
  body.querySelectorAll<HTMLInputElement>('[data-mute]').forEach(el => el.onchange = () => {
    const set = new Set(config().notifyMuted || [])
    if (el.checked) set.delete(el.dataset.mute!); else set.add(el.dataset.mute!)
    void update({ notifyMuted: [...set] })
  })
  onClickOf('[data-test-notify]', async () => {
    try { notify(await window.api.testNotification() ? '테스트 알림을 보냈어요.' : '이 PC에서는 Windows 알림을 쓸 수 없어요.') }
    catch { notify('테스트 알림을 보내지 못했어요.') }
  })

  // 서비스
  body.querySelectorAll<HTMLElement>('[data-expand]').forEach(el => el.onclick = () => { expanded = expanded === el.dataset.expand ? '' : el.dataset.expand!; renderSettings(state, true) })
  body.querySelectorAll<HTMLInputElement>('[data-enabled]').forEach(el => el.onchange = () => run(window.api.toggleAccount(el.dataset.enabled!, el.checked), '조회 설정을 저장하지 못했어요.'))
  body.querySelectorAll<HTMLInputElement>('[data-name-input]').forEach(el => {
    const save = () => { const id = el.dataset.nameInput!, name = el.value.trim(); if (name && name !== state.accounts.find(a => a.id === id)?.name) run(window.api.renameAccount(id, name), '이름을 저장하지 못했어요.') }
    el.onchange = save
    el.onkeydown = e => { if (e.key === 'Enter') el.blur(); else if (e.key === 'Escape') { el.value = state.accounts.find(a => a.id === el.dataset.nameInput)?.name || el.value; el.blur() } }
  })
  body.querySelectorAll<HTMLElement>('[data-visibility]').forEach(el => el.onclick = async () => {
    const id = el.dataset.id!, a = state.accounts.find(x => x.id === id); if (!a) return
    const v = el.dataset.visibility
    try {
      if ((v === 'none') !== !!a.hidden) await window.api.hideAccount(id, v === 'none')
      if (v !== 'none' && (v === 'window') !== !!a.hiddenInDock) await window.api.setAccountDisplay(id, { hiddenInDock: v === 'window' })
    } catch { notify('표시 설정을 저장하지 못했어요.') }
  })
  body.querySelectorAll<HTMLElement>('[data-barcolor]').forEach(el => el.onclick = () => {
    const v = el.dataset.barcolor!, id = el.dataset.id!
    if (v === 'custom') { body.querySelector<HTMLInputElement>(`[data-barcolor-pick="${CSS.escape(id)}"]`)?.click(); return }
    run(window.api.setAccountDisplay(id, { barColor: v }), '색을 저장하지 못했어요.')
  })
  body.querySelectorAll<HTMLInputElement>('[data-barcolor-pick]').forEach(el => el.onchange = () => run(window.api.setAccountDisplay(el.dataset.barcolorPick!, { barColor: el.value }), '색을 저장하지 못했어요.'))
  body.querySelectorAll<HTMLElement>('[data-launch-pick]').forEach(el => el.onclick = async () => {
    const kind = el.dataset.launchPick as 'cli' | 'app', file = await window.api.pickFile(kind)
    if (file) run(window.api.setAccountDisplay(el.dataset.id!, kind === 'cli' ? { launchCli: file } : { launchApp: file }), '실행할 것을 저장하지 못했어요.')
  })
  body.querySelectorAll<HTMLElement>('[data-cwd-pick]').forEach(el => el.onclick = async () => {
    const dir = await window.api.pickFolder('CLI를 열 때 시작할 폴더 고르기')
    if (dir) run(window.api.setAccountDisplay(el.dataset.id!, { launchCwd: dir }), '시작 폴더를 저장하지 못했어요.')
  })
  body.querySelectorAll<HTMLElement>('[data-cwd-reset]').forEach(el => el.onclick = () => run(window.api.setAccountDisplay(el.dataset.id!, { launchCwd: '' }), '홈 폴더로 되돌리지 못했어요.'))
  body.querySelectorAll<HTMLElement>('[data-launch-auto]').forEach(el => el.onclick = () => {
    const kind = el.dataset.launchAuto as 'cli' | 'app'
    run(window.api.setAccountDisplay(el.dataset.id!, kind === 'cli' ? { launchCli: '' } : { launchApp: '' }), '자동으로 되돌리지 못했어요.')
  })
  body.querySelectorAll<HTMLInputElement>('[data-scoped]').forEach(el => el.onchange = () => run(window.api.setAccountDisplay(el.dataset.scoped!, { showScoped: el.checked }), '표시 설정을 저장하지 못했어요.'))
  body.querySelectorAll<HTMLElement>('[data-order]').forEach(el => el.onclick = () => run(window.api.reorderAccount(el.dataset.id!, el.dataset.order as 'up' | 'down'), '순서를 저장하지 못했어요.'))
  body.querySelectorAll<HTMLElement>('[data-remove]').forEach(el => el.onclick = () => {
    const a = state.accounts.find(x => x.id === el.dataset.remove); if (!a) return
    if (!confirm(`'${a.name}'을(를) 목록에서 뺄까요?\n다시 넣으려면 '서비스 추가'에서 추가하세요.`)) return
    expanded = ''
    run(window.api.removeAccount(a.id), '목록에서 빼지 못했어요.')
  })
  onClickOf('[data-redetect]', () => { void detectApps(); void window.api.refreshQuota() })
  body.querySelectorAll<HTMLElement>('[data-add-app]').forEach(el => el.onclick = () => {
    const app = detected?.find(x => x.id === el.dataset.addApp); if (app) run(window.api.restoreDetectedApp(app), '추가하지 못했어요.')
  })
  onClickOf('[data-custom-open]', () => { addingCustom = true; renderSettings(state, true); body.querySelector<HTMLInputElement>('[data-custom="name"]')?.focus() })
  // 직접 입력 양식: Enter는 추가, Esc는 취소
  body.querySelectorAll<HTMLInputElement>('[data-custom]').forEach(el => el.oninput = () => { (customDraft as Record<string, string>)[el.dataset.custom!] = el.value })
  body.querySelectorAll<HTMLInputElement>('[data-custom]').forEach(el => el.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); body.querySelector<HTMLElement>('[data-custom-save]')?.click() }
    else if (e.key === 'Escape') body.querySelector<HTMLElement>('[data-custom-cancel]')?.click()
  })
  onClickOf('[data-custom-cancel]', () => { addingCustom = false; renderSettings(state, true) })
  onClickOf('[data-custom-save]', () => {
    const val = (k: string) => body.querySelector<HTMLInputElement>(`[data-custom="${k}"]`)?.value || ''
    const pct = (k: string) => { const n = Number(val(k)); return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 100 }
    const name = val('name').trim()
    if (!name) { notify('이름을 넣어 주세요.'); body.querySelector<HTMLInputElement>('[data-custom="name"]')?.focus(); return }
    addingCustom = false
    Object.assign(customDraft, { name: '', p5: '100', pw: '100' })
    // 입력 칸에 커서가 남아 있으면 '입력 중'으로 보고 다시 그리지 않으므로 먼저 빠져나온다.
    ;(document.activeElement as HTMLElement | null)?.blur()
    renderSettings(state, true)
    run(window.api.addCustomAccount({ name, provider: 'custom', customMock: { primaryPercent: 100 - pct('p5'), primaryReset: '', weeklyPercent: 100 - pct('pw'), weeklyReset: '', iconLetter: name.charAt(0).toUpperCase(), brandColor: val('color') } }), '추가하지 못했어요.')
  })
  // 다른 로그인 폴더의 계정
  onClickOf('[data-home-open]', () => { addingHome = true; renderSettings(state, true) })
  onClickOf('[data-home-cancel]', () => { addingHome = false; renderSettings(state, true) })
  body.querySelectorAll<HTMLElement>('[data-home-provider]').forEach(el => el.onclick = () => { homeDraft.provider = el.dataset.homeProvider as 'codex' | 'xai'; renderSettings(state, true) })
  onClickOf('[data-home-pick]', async () => { const dir = await window.api.pickFolder(); if (dir) { homeDraft.dir = dir; renderSettings(state, true) } })
  const homeName = body.querySelector<HTMLInputElement>('[data-home-name]')
  if (homeName) homeName.oninput = () => { homeDraft.name = homeName.value }
  onClickOf('[data-home-save]', async () => {
    if (!homeDraft.dir) { notify('로그인 폴더를 골라 주세요.'); return }
    ;(document.activeElement as HTMLElement | null)?.blur()
    try {
      const r = await window.api.addHomeAccount(homeDraft.provider, homeDraft.dir, homeDraft.name)
      if (r.message) notify(r.message)
      if (r.ok) { addingHome = false; Object.assign(homeDraft, { dir: '', name: '' }); renderSettings(r.state || state, true) }
    } catch { notify('추가하지 못했어요.') }
  })
  onClickOf('[data-reset-defaults]', () => {
    if (!confirm('서비스 목록을 기본으로 되돌릴까요?\n직접 추가한 카드와 바꾼 이름이 사라져요.')) return
    run(window.api.resetDefaultAccounts(), '되돌리지 못했어요.')
  })
}
