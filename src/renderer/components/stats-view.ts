import type { AppState, HistoryPoint } from '../../common/types.js'
import { buckets, type DailyStore, type Period } from '../../common/stats.js'
import { renderAiIcon } from './ai-icons.js'
import { applyAppearance, escapeText } from './dashboard.js'
import { updateMarkup } from '../dom-update.js'

/**
 * '사용량 통계' 창. 일간(최근 30일)·주간(12주)·월간(12달) 막대그래프와 합계·평균, 그리고 남은 양 흐름(24시간·7일).
 * 단위는 모두 주간 한도의 %다. 날짜별 사용량은 메인이 1년 보관하고(getDaily), 남은 양은 원본 기록(getHistory)에서 그린다.
 */
type View = Period | 'remain'
const VIEWS: Array<[View, string]> = [['day', '일간'], ['week', '주간'], ['month', '월간'], ['remain', '남은 양']]
const PER: Record<Period, string> = { day: '하루', week: '한 주', month: '한 달' }
const RANGE: Record<Period, string> = { day: '최근 30일', week: '최근 12주', month: '최근 12달' }
// 고르게 쓰면 이만큼: 하루는 주간 한도의 1/7, 한 주는 주간 한도 전부
const PACE: Partial<Record<Period, [number, string]>> = { day: [100 / 7, '고르게 쓰면 하루 14%'], week: [100, '주간 한도 100%'] }

let view: View = 'day'
let daily: DailyStore = {}
let state: AppState
let host: HTMLElement
let focusId = ''
let remainId = ''
let remainRange: 'day' | 'week' = 'day'
let lastRefreshed: string | undefined
let bound = false

const hint = (text: string) => `<p class="setting-hint">${text}</p>`
const hex = (v?: string) => /^#[\da-f]{6}$/i.test(v || '') ? v! : 'var(--accent)'
const pct = (n: number) => `${n >= 100 ? Math.round(n) : Math.round(n * 10) / 10}%`

/** 통계에 보여 줄 서비스: 켜 둔 계정 중 지금 값이 있거나 쌓인 기록이 있는 것(지금 카드 순서대로). */
function services() {
  return state.accounts.filter(a => a.enabled).map(a => ({ a, u: state.usages.find(u => u.id === a.id) }))
    .filter(({ a, u }) => (u && ['ready', 'stale'].includes(u.status)) || daily[a.id])
}

export async function renderStats(container: HTMLElement, s: AppState, focus?: string) {
  host = container
  state = s
  if (focus) { focusId = focus; remainId = focus }
  applyAppearance(s.config)
  // 사용량을 새로 확인했으면 날짜별 합계도 다시 받는다.
  if (lastRefreshed !== s.lastRefreshedAt) { lastRefreshed = s.lastRefreshedAt; daily = await window.api.getDaily().catch(() => daily) }
  draw()
}

function draw() {
  const list = services()
  const body = !list.length ? hint('아직 보여 줄 서비스가 없어요. 사용량을 조회할 때마다 이 PC에 기록이 쌓여요.')
    : view === 'remain' ? remainView(list) : list.map(x => periodCard(x.a.id, x.a.name, x.a.provider, x.u?.barColor || x.u?.brandColor, view as Period)).join('')
  updateMarkup(host, `<div class="dashboard stats-root">
    <header class="s-titlebar"><span class="app-symbol" aria-hidden="true"><i></i><i></i><i></i></span><span class="app-title">AI 사용량 통계</span><div class="s-winbtns"><button data-win="minimize" title="최소화" aria-label="최소화"><svg viewBox="0 0 10 10"><path d="M0 5h10"/></svg></button><button data-win="maximize" title="최대화" aria-label="최대화"><svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg></button><button data-win="close" class="close" title="닫기" aria-label="닫기"><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg></button></div></header>
    <div class="stats-bar"><div class="segmented" role="group" aria-label="기간">${VIEWS.map(([k, label]) => `<button data-view="${k}" aria-pressed="${view === k}">${label}</button>`).join('')}</div>
      <span class="stats-unit">${view === 'remain' ? '남은 양(%)의 흐름' : `${RANGE[view]} · 단위: 주간 한도의 %`}</span></div>
    <main class="stats-body">${body}</main>
  </div>`)
  if (view === 'remain') void drawRemain()
  if (focusId) { host.querySelector(`[data-st="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'nearest' }); focusId = '' }
  bind()
}

/** 서비스 하나의 기간별 막대그래프와 합계·평균·가장 많이 쓴 칸. */
function periodCard(id: string, name: string, provider: string, color: string | undefined, period: Period) {
  const bs = buckets(daily[id], period), brand = hex(color)
  const first = bs.findIndex(b => b.total > 0)
  const shown = first < 0 ? [] : bs.slice(first)
  const sum = shown.reduce((n, b) => n + b.total, 0)
  // 평균은 기록이 처음 생긴 칸부터 센다(설치 전 기간까지 0으로 넣으면 평균이 낮아 보인다).
  const avg = shown.length ? sum / shown.length : 0
  const top = shown.reduce((m, b) => b.total > m.total ? b : m, shown[0] || bs[0])
  const head = `<div class="st-head">${renderAiIcon(provider, name, state.config.iconStyle, 18)}<b>${escapeText(name)}</b>
    <span class="st-sum">${first < 0 ? '아직 기록이 없어요' : `합계 <b>${pct(sum)}</b> · 평균 <b>${pct(avg)}</b>/${PER[period]} · 가장 많이 ${escapeText(top.tip)} <b>${pct(top.total)}</b>`}</span></div>`
  return `<section class="st-card ${focusId === id ? 'is-focus' : ''}" data-st="${escapeText(id)}">${head}${barChart(bs, brand, period)}</section>`
}

function barChart(bs: ReturnType<typeof buckets>, brand: string, period: Period) {
  const W = 600, H = 150, L = 34, R = 6, T = 8, B = 20
  const pace = PACE[period]
  const max = Math.max(pace ? pace[0] * 1.15 : 0, ...bs.map(b => b.total), 1)
  const top = max <= 20 ? Math.ceil(max / 5) * 5 : max <= 120 ? Math.ceil(max / 20) * 20 : Math.ceil(max / 100) * 100
  const y = (v: number) => T + (1 - v / top) * (H - T - B), slot = (W - L - R) / bs.length, bw = Math.max(3, slot * .64)
  const every = period === 'day' ? 5 : period === 'week' ? 2 : 1
  const grid = [0, top / 2, top].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end" font-size="9" fill="var(--dim)">${Math.round(v)}</text>`).join('')
  const bars = bs.map((b, i) => {
    const x = L + slot * i + (slot - bw) / 2, h = Math.max(b.total > 0 ? 1.5 : 0, y(0) - y(b.total))
    const current = i === bs.length - 1
    return `<rect x="${x.toFixed(1)}" y="${(y(0) - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${brand}" opacity="${current ? .55 : .9}"/>`
      + `<rect x="${(L + slot * i).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${H - T - B}" fill="transparent" data-tip="${escapeText(`${b.tip}${current ? ' (진행 중)' : ''} · 주간 한도의 ${pct(b.total)}`)}"/>`
      + ((bs.length - 1 - i) % every === 0 ? `<text x="${(L + slot * i + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="var(--dim)">${b.label}</text>` : '')
  }).join('')
  const paceLine = pace ? `<line x1="${L}" x2="${W - R}" y1="${y(pace[0])}" y2="${y(pace[0])}" stroke="var(--muted)" stroke-dasharray="4 3"/><text x="${W - R}" y="${y(pace[0]) - 3}" text-anchor="end" font-size="9" fill="var(--muted)" stroke="rgb(var(--surface))" stroke-width="3" paint-order="stroke">${pace[1]}</text>` : ''
  return `<svg viewBox="0 0 ${W} ${H}" class="st-svg" role="img">${grid}${bars}${paceLine}</svg>`
}

/** 남은 양 흐름: 서비스 하나를 골라 최근 24시간·7일의 5시간·주간 남은 %. */
function remainView(list: ReturnType<typeof services>) {
  if (!list.some(x => x.a.id === remainId)) remainId = list[0].a.id
  return `<div class="chip-row">${list.map(({ a }) => `<button class="chip-btn" data-remain="${escapeText(a.id)}" aria-pressed="${a.id === remainId}">${renderAiIcon(a.provider, a.name, state.config.iconStyle, 16)}${escapeText(a.name)}</button>`).join('')}</div>
    <div class="segmented st-range" role="group" aria-label="범위"><button data-rrange="day" aria-pressed="${remainRange === 'day'}">최근 24시간</button><button data-rrange="week" aria-pressed="${remainRange === 'week'}">최근 7일</button></div>
    <section class="st-card"><div class="hist-chart" data-hist-chart data-keep>${hint('불러오는 중…')}</div>${hint('남은 양(%)의 흐름이에요. 원본 기록은 30일 동안 보관해요.')}</section>`
}

let remainSeq = 0
async function drawRemain() {
  const box = host.querySelector<HTMLElement>('[data-hist-chart]'); if (!box || !remainId) return
  const seq = ++remainSeq
  const now = Date.now(), span = remainRange === 'day' ? 86400e3 : 7 * 86400e3, from = now - span
  const u = state.usages.find(x => x.id === remainId), a = state.accounts.find(x => x.id === remainId)
  let pts: HistoryPoint[]
  try { pts = await window.api.getHistory(remainId, from, now, 300) }
  catch { if (seq === remainSeq) box.innerHTML = hint('기록을 불러오지 못했어요.'); return }
  if (seq !== remainSeq || !box.isConnected) return
  if (pts.length < 2) { box.innerHTML = hint('이 기간에는 기록이 아직 충분하지 않아요.'); return }
  const W = 600, H = 200, L = 30, B = 20
  const px = (t: number) => L + (t - from) / span * (W - L - 6), py = (v: number) => 6 + (1 - v / 100) * (H - B - 6)
  const line = (idx: 1 | 2) => { const ps = pts.filter(p => p[idx] !== null); return ps.length < 2 ? '' : ps.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)} ${py(p[idx]!).toFixed(1)}`).join('') }
  const brand = hex(u?.barColor || u?.brandColor), l5 = line(1), lw = line(2)
  const ticks: Array<[number, string]> = remainRange === 'day' ? [[from, '24시간 전'], [from + span / 2, '12시간 전'], [now, '지금']] : [[from, '7일 전'], [from + span * 4 / 7, '3일 전'], [now, '지금']]
  const lows = (idx: 1 | 2) => { const v = pts.map(p => p[idx]).filter((n): n is number => n !== null); return v.length ? Math.min(...v) : null }
  const weekColor = `color-mix(in srgb,${brand} 55%,var(--muted))`
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="st-svg" role="img" aria-label="${escapeText(a?.name || '')} 남은 양 추이">`
    + [0, 50, 100].map(v => `<line x1="${L}" x2="${W - 6}" y1="${py(v)}" y2="${py(v)}" stroke="var(--line)"/><text x="${L - 5}" y="${py(v) + 3}" text-anchor="end" font-size="9" fill="var(--dim)">${v}</text>`).join('')
    + ticks.map(([t, label], i) => `<text x="${px(t)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" font-size="9" fill="var(--dim)">${label}</text>`).join('')
    + (lw ? `<path d="${lw}" fill="none" stroke="${weekColor}" stroke-width="1.6" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>` : '')
    + (l5 ? `<path d="${l5}" fill="none" stroke="${brand}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>` : '')
    + `</svg><div class="hist-legend">${l5 ? `<span><i style="background:${brand}"></i>${u?.primaryKind === 'monthly' ? '월간' : '5시간'} · 최저 ${lows(1)}%</span>` : ''}${lw ? `<span><i class="dash" style="border-color:${weekColor}"></i>주간 · 최저 ${lows(2)}%</span>` : ''}</div>`
}

function bind() {
  if (bound) return
  bound = true
  host.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button'); if (!t) return
    if (t.dataset.win) window.api.windowControl(t.dataset.win as 'minimize' | 'maximize' | 'close')
    else if (t.dataset.view) { view = t.dataset.view as View; draw() }
    else if (t.dataset.remain) { remainId = t.dataset.remain; draw() }
    else if (t.dataset.rrange) { remainRange = t.dataset.rrange as 'day' | 'week'; draw() }
  })
  window.addEventListener('keydown', e => { if (e.key === 'Escape') window.api.windowControl('close') })
}

/** 이미 열린 통계 창에서 다른 서비스를 고르면(카드 우클릭 '이 서비스 통계') 그 서비스로 옮겨 간다. */
export function focusStats(id: string) {
  focusId = id; remainId = id
  if (state) draw()
}
