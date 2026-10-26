import type { AccountUsage, HistoryPoint, WidgetConfig } from '../../common/types.js'
import {
  cardBody, fitDesign, fmtDuration, fmtDurationShort, formOf, paceWarning, pickWindow, richScale, richTier, serviceModel, severity, unusedWeekly, windowsOf, worstWindow,
  type DesignId, type QuotaWindow, type ServiceModel, type ValueSource,
} from '../../common/usage-model.js'
import { renderAiIcon } from './ai-icons.js'

/** 대시보드 카드 렌더러. 디자인마다 기본 형태와 작은 카드 형태가 있고, 작아져도 다른 디자인으로 바꿔 그리지 않는다. */
export interface ViewContext {
  warn: number
  crit: number
  showPace: boolean
  showReset: boolean
  showUsed: boolean
  colorByUsage: boolean
  iconStyle: WidgetConfig['iconStyle']
  source: (id: string) => ValueSource
  history?: Record<string, HistoryPoint[]>
}
export function viewContext(config: WidgetConfig, history?: Record<string, HistoryPoint[]>): ViewContext {
  const warn = Math.max(1, Math.min(60, config.warnPercent ?? 20))
  return {
    warn, crit: Math.max(0, Math.min(warn, config.critPercent ?? 10)), showPace: config.showPace !== false,
    showReset: config.showResetTime !== false, showUsed: !!config.showUsedPercent, colorByUsage: config.colorByUsage !== false,
    iconStyle: config.iconStyle, source: id => config.valueSource?.[id] || 'weekly', history,
  }
}

/** 최근 24시간 추이선. 표본이 3개 미만이면 그리지 않는다. */
function spark(m: ServiceModel, x: ViewContext, w: QuotaWindow, height: number) {
  const now = Date.now(), from = now - 86400e3, idx = w.key === '5h' ? 1 : 2
  const pts = (x.history?.[m.id] || []).filter(p => p[0] >= from && p[idx] !== null)
  if (pts.length < 3) return ''
  const px = (p: HistoryPoint) => ((p[0] - from) / 86400e3 * 100).toFixed(2)
  const py = (p: HistoryPoint) => { const v = x.showUsed ? 100 - p[idx]! : p[idx]!; return (1 + (1 - v / 100) * (height - 2)).toFixed(2) }
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p)} ${py(p)}`).join('')
  return `<svg class="spark" viewBox="0 0 100 ${height}" preserveAspectRatio="none" height="${height}" aria-hidden="true"><path d="${line}L${px(pts.at(-1)!)} ${height}L${px(pts[0])} ${height}Z" fill="${color(x, m, w)}" opacity=".12"/><path d="${line}" fill="none" stroke="${color(x, m, w)}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`
}

const esc = (v: string) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const hex = (v?: string) => /^#[\da-f]{6}$/i.test(v || '') ? v! : '#a99bff'
const chev = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>'

/* ---------- 값·색 ---------- */
// '사용한 양으로 표시'를 켜면 숫자와 그림 모두 사용량을 기준으로 바뀐다. 경고 판정은 항상 남은 양 기준.
const shown = (x: ViewContext, w: QuotaWindow) => x.showUsed ? w.used : w.left
const expected = (x: ViewContext, w: QuotaWindow) => w.expectedLeft === null ? null : x.showUsed ? 100 - w.expectedLeft : w.expectedLeft
const color = (x: ViewContext, m: ServiceModel, w: QuotaWindow) =>
  !x.colorByUsage ? hex(m.brand) : w.left <= x.crit ? 'var(--danger)' : w.left <= x.warn ? 'var(--warn)' : hex(m.brand)
const valColor = (x: ViewContext, w: QuotaWindow) => x.colorByUsage && w.left <= x.warn ? (w.left <= x.crit ? 'var(--danger)' : 'var(--warn)') : 'var(--ink)'
const remainWord = (x: ViewContext) => x.showUsed ? '사용' : '남음'

const bar = (x: ViewContext, m: ServiceModel, w: QuotaWindow, vert = false) => {
  const e = x.showPace ? expected(x, w) : null
  return `<div class="track"><div class="fill" style="--c:${color(x, m, w)};${vert ? `height:${shown(x, w)}%` : `width:${shown(x, w)}%`}"></div>${e === null ? '' : vert ? `<i class="pace" style="bottom:calc(${e}% - 1px)"></i>` : `<i class="pace" style="left:calc(${e}% - 1px)"></i>`}</div>`
}
const num = (x: ViewContext, w: QuotaWindow, size: number) =>
  `<span class="big" style="font-size:${Math.round(size)}px;color:${valColor(x, w)}">${shown(x, w)}<span class="unit" style="font-size:${Math.round(size * .44)}px">%</span></span>`
const smallVal = (x: ViewContext, w: QuotaWindow) => `<span class="num" style="color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span>`

function headline(m: ServiceModel, x: ViewContext) {
  const w = worstWindow(m)
  if (!w) return { t: '', hot: false }
  if (paceWarning(w)) return { t: `${w.label} 한도가 리셋보다 ${fmtDuration(w.resetMs! - w.toEmptyMs!)} 먼저 바닥날 수 있어요`, hot: true }
  if (w.left <= x.warn) return { t: `${w.label} 여유가 ${w.left}%뿐이에요`, hot: true }
  const unused = unusedWeekly(m)
  if (unused) return { t: `주간 여유 ${unused.left}%가 ${fmtDuration(unused.resetMs)} 뒤 초기화돼요`, hot: false }
  if (w.runsOut) return { t: `지금 속도면 ${w.label} 한도가 ${fmtDuration(w.toEmptyMs)} 뒤 소진돼요`, hot: false }
  return { t: windowsOf(m).length > 1 ? '두 한도 모두 여유 있어요' : '여유 있어요', hot: false }
}
function noteOf(w: QuotaWindow) {
  if (w.used === 0) return { t: '아직 쓰지 않음', hot: false }
  if (w.runsOut) return { t: `이 속도면 ${fmtDuration(w.toEmptyMs)} 뒤 소진`, hot: paceWarning(w) }
  if (w.pace !== null && w.pace > 1.15) return { t: '시간보다 빠르게 쓰는 중', hot: false }
  return { t: w.elapsed === null ? '리셋 시각 정보 없음' : '리셋 전까지 여유', hot: false }
}

/* ---------- 종합: 크기 단계 ---------- */
function rich(m: ServiceModel, x: ViewContext, b: { w: number; h: number }) {
  const t = richTier(b.w, b.h), { main } = pickWindow(m, x.source(m.id)), h = headline(m, x), ws = windowsOf(m)
  const k = ['mw', 'ml', 'l', 'lw'].includes(t) ? richScale(b.w, b.h) : 1
  const big = (size: number) => num(x, main, size)
  const resetText = (w: QuotaWindow) => w.resetMs === null ? '' : b.w >= 260 ? `리셋 ${fmtDuration(w.resetMs)} 뒤` : b.w >= 150 ? fmtDurationShort(w.resetMs) : ''
  const row = (w: QuotaWindow, withNote: boolean) => {
    const n = noteOf(w)
    return `<div class="row"><div class="row-top"><span class="lbl">${w.label}</span><span class="row-val num" style="color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span><span class="cap row-reset">${resetText(w)}</span></div>${bar(x, m, w)}${withNote ? `<div class="row-note ${n.hot ? 'hot' : ''}">${n.t}</div>` : ''}</div>`
  }
  const inline = (w: QuotaWindow, reset: boolean) => `<div class="inline-row ${reset ? 'with-reset' : ''}"><span class="lbl">${w.label}</span>${bar(x, m, w)}<span class="row-val num" style="color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span>${reset ? `<span class="cap">${w.resetMs === null ? '' : fmtDurationShort(w.resetMs)}</span>` : ''}</div>`
  const rows = (note: boolean) => ws.map(w => row(w, note)).join('')
  const sum = (size: number, head: boolean, extra = '') => `<div class="rich-sum">${big(size)}<div class="lbl sub" ${extra}>${main.label} ${remainWord(x)}</div>${head && h.t ? `<div class="rich-head ${h.hot ? 'hot' : ''}">${esc(h.t)}</div>` : ''}</div>`
  const wrap = (cls: string, inner: string) => `<div style="--k:${k.toFixed(2)}" class="rich ${cls}">${inner}</div>`
  if (t === 's') return wrap('t-s', `<div class="rows">${ws.map(w => inline(w, b.w >= 290)).join('')}</div>`)
  if (t === 'm') return wrap('t-m', `<div class="rows">${rows(false)}</div>`)
  if (t === 'mw') return wrap('t-mw', `${sum(Math.max(30, Math.min(b.h * .5, 48)), false)}<div class="rows">${rows(false)}</div>`)
  if (t === 'tall') {
    const vb = (w: QuotaWindow) => `<div class="vbar">${bar(x, m, w, true)}<span class="num row-val" style="color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span><span class="cap">${w.label}</span></div>`
    return wrap('t-tall', `${sum(Math.max(28, Math.min(b.w * .36, 44)), false)}<div class="vbars">${ws.map(vb).join('')}</div>`)
  }
  // 공간이 넉넉한 넓은 카드에는 최근 24시간 추이선을 덧붙인다.
  // 하루 사이에 움직이는 것은 5시간 한도라 24시간 추이선은 5시간 한도를 우선 그린다.
  const sparkWin = m.w5 || main
  const sparkBlock = (h: number) => { const sv = spark(m, x, sparkWin, h); return sv ? `<div class="rich-spark">${sv}<span class="cap">최근 24시간 · ${sparkWin.label}</span></div>` : '' }
  if (t === 'lw') {
    const size = Math.max(38, Math.min(b.h * .42, 64 * k)), withSpark = b.h >= 140
    return wrap('t-lw', `<div class="rich-sum ${withSpark ? (b.h >= 175 ? 'with-spark' : 'with-spark tight') : ''}">${big(withSpark ? Math.min(size, b.h >= 175 ? 52 : 40) : size)}<div class="lbl sub">${main.label} ${remainWord(x)}</div>${h.t ? `<div class="rich-head ${h.hot ? 'hot' : ''}">${esc(h.t)}</div>` : ''}${withSpark ? sparkBlock(26) : ''}</div><div class="rows">${rows(true)}</div>`)
  }
  if (t === 'ml') return wrap('t-l t-ml', `${sum(Math.max(30, Math.min(b.w * .16, b.h * .22, 44)), true)}<div class="rows">${rows(false)}</div>`)
  return wrap('t-l', `${sum(Math.max(34, Math.min(b.w * .2, b.h * .22, 60 * k)), true)}<div class="rows">${rows(true)}</div>${b.h >= 212 * k + 56 ? sparkBlock(30) : ''}`)
}

/* ---------- 다른 디자인: 기본 형태 ---------- */
function numeral(m: ServiceModel, x: ViewContext, b: { w: number; h: number; o: 'h' | 'v' }) {
  const { main, other } = pickWindow(m, x.source(m.id)), v = b.o === 'v'
  const size = Math.max(28, Math.min(v ? b.w * .42 : b.w * .26, b.h * (v ? .4 : .66), 84))
  return `<div class="v-numeral ${v ? 'v' : ''}">${num(x, main, size)}<div class="sub"><span class="lbl">${main.label} ${remainWord(x)}</span>${other ? `<span class="lbl num" style="color:${valColor(x, other)}">${other.label} ${shown(x, other)}%</span>` : ''}</div></div>`
}
function bars(m: ServiceModel, x: ViewContext, b: { w: number; h: number; o: 'h' | 'v' }) {
  const v = b.o === 'v'
  const row = (w: QuotaWindow) => `<div class="bar-row" ${v ? 'style="height:100%"' : ''}><div class="bar-cap"><span class="lbl">${w.label}</span><span class="num row-val" style="color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span></div>${bar(x, m, w, v)}</div>`
  return `<div class="v-bars ${v ? 'v' : ''}">${windowsOf(m).map(row).join('')}</div>`
}
const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
  const p = (a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  const [x0, y0] = p(a0), [x1, y1] = p(a1)
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}
const A0 = Math.PI * .75, SW = Math.PI * 1.5
// 바깥 링 = 주간, 안쪽 링 = 5시간. 한도가 하나뿐이면 링 하나.
function ringSVG(m: ServiceModel, x: ViewContext, size: number, center: QuotaWindow | null, sw = 6, pace = true) {
  const ring = (r: number, w: QuotaWindow) => {
    const e = pace && x.showPace ? expected(x, w) : null, pa = e === null ? 0 : A0 + SW * e / 100
    return `<path d="${arc(50, 50, r, A0, A0 + SW)}" stroke="var(--svg-track2)" stroke-width="${sw}" fill="none"/><path d="${arc(50, 50, r, A0, A0 + SW * Math.max(.001, shown(x, w) / 100))}" stroke="${color(x, m, w)}" stroke-width="${sw}" fill="none"/>${e === null ? '' : `<line x1="${50 + (r - sw * .75) * Math.cos(pa)}" y1="${50 + (r - sw * .75) * Math.sin(pa)}" x2="${50 + (r + sw * .75) * Math.cos(pa)}" y2="${50 + (r + sw * .75) * Math.sin(pa)}" stroke="var(--svg-tick)" stroke-width="1.2"/>`}`
  }
  const outer = m.ww || m.w5!, inner = m.ww && m.w5 ? m.w5 : null
  return `<svg viewBox="0 0 100 100" width="${Math.round(size)}" height="${Math.round(size)}" style="flex-shrink:0" aria-hidden="true">${ring(42, outer)}${inner ? ring(42 - sw - 4, inner) : ''}${center ? `<text x="50" y="${size < 60 ? 58 : 55}" text-anchor="middle" fill="${valColor(x, center)}" font-size="${size < 60 ? 24 : 19}" font-weight="650" font-family="Segoe UI Variable Display,Segoe UI" letter-spacing="-.8">${shown(x, center)}<tspan font-size="${size < 60 ? 10 : 8}" fill="var(--dim)">%</tspan></text>` : ''}</svg>`
}
function rings(m: ServiceModel, x: ViewContext, b: { w: number; h: number; o: 'h' | 'v' }) {
  const { main } = pickWindow(m, x.source(m.id)), v = b.o === 'v', side = Math.max(60, Math.min(v ? b.w : b.w * .58, v ? b.h * .74 : b.h))
  const lg = (w: QuotaWindow, where: string) => `<div class="lg"><span class="lbl"><i class="dot" style="background:${color(x, m, w)}"></i>${w.label}${v || !where ? '' : ` · ${where}`}</span><span class="num" style="color:${valColor(x, w)}">${shown(x, w)}%</span></div>`
  const legend = b.w > 230 || v ? `<div class="legend">${m.ww ? lg(m.ww, m.w5 ? '바깥' : '') : ''}${m.w5 ? lg(m.w5, m.ww ? '안쪽' : '') : ''}</div>` : ''
  return `<div class="svgwrap ${v ? 'v' : ''}">${ringSVG(m, x, side, main)}${legend}</div>`
}
function timeline(m: ServiceModel, x: ViewContext, b: { w: number; h: number; o: 'h' | 'v' }) {
  const v = b.o === 'v', W = v ? 100 : 300, Hh = v ? 260 : 118, ws = [m.ww, m.w5].filter(Boolean) as QuotaWindow[]
  const lane = (px: number, py: number, len: number, w: QuotaWindow, ticks: number, name: string, vert: boolean) => {
    // 시간축(지난 시간 음영 + 지금 표시)과 남은 양 막대를 같은 길이로 나란히 둬서 '시간 vs 남은 양'을 비교한다.
    const t: string[] = []
    for (let i = 1; i < ticks; i++) { const k = len * i / ticks; t.push(vert ? `<line x1="${px}" x2="${px + 10}" y1="${py + len - k}" y2="${py + len - k}" stroke="var(--svg-track2)"/>` : `<line x1="${px + k}" x2="${px + k}" y1="${py}" y2="${py + 10}" stroke="var(--svg-track2)"/>`) }
    const el = len * (w.elapsed ?? 0), fuel = len * shown(x, w) / 100, c = color(x, m, w), vc = x.colorByUsage && w.left <= x.warn ? c : 'var(--ink)'
    const now = w.elapsed === null ? '' : vert ? `<line x1="${px - 3}" x2="${px + 25}" y1="${py + len - el}" y2="${py + len - el}" stroke="var(--svg-tick)" stroke-width="1.1" opacity=".75"/>` : `<line x1="${px + el}" x2="${px + el}" y1="${py - 2}" y2="${py + 21}" stroke="var(--svg-tick)" stroke-width="1.1" opacity=".75"/>`
    if (vert) return `<text x="${px + 11}" y="${py - 6}" text-anchor="middle" fill="var(--muted)" font-size="9">${name}</text><rect x="${px}" y="${py}" width="10" height="${len}" rx="1" fill="var(--svg-track)"/><rect x="${px}" y="${py + len - el}" width="10" height="${el}" rx="1" fill="var(--svg-elapsed)"/>${t.join('')}<rect x="${px + 13}" y="${py}" width="9" height="${len}" rx="1" fill="var(--svg-track)"/><rect x="${px + 13}" y="${py + len - fuel}" width="9" height="${fuel}" rx="1" fill="${c}"/>${now}<text x="${px + 11}" y="${py + len + 15}" text-anchor="middle" fill="${vc}" font-size="12" font-weight="650">${shown(x, w)}%</text>`
    return `<text x="${px}" y="${py - 6}" fill="var(--muted)" font-size="10">${name}</text><text x="${px + len}" y="${py - 6}" text-anchor="end" fill="var(--dim)" font-size="9.5">${w.resetMs === null ? '' : `리셋 ${fmtDuration(w.resetMs)} 뒤`}</text><rect x="${px}" y="${py}" width="${len}" height="10" rx="1" fill="var(--svg-track)"/><rect x="${px}" y="${py}" width="${el}" height="10" rx="1" fill="var(--svg-elapsed)"/>${t.join('')}<rect x="${px}" y="${py + 13}" width="${len}" height="6" rx="1" fill="var(--svg-track)"/><rect x="${px}" y="${py + 13}" width="${fuel}" height="6" rx="1" fill="${c}"/>${now}<text x="${px + len + 8}" y="${py + 18}" fill="${vc}" font-size="13" font-weight="650">${shown(x, w)}%</text>`
  }
  const names = (w: QuotaWindow, vert: boolean) => w.period === 'weekly' && !vert ? '주간 (7일)' : w.label
  // 눈금: 5시간은 1시간, 주간은 하루, 월간은 한 주 간격.
  const ticks = (w: QuotaWindow) => w.period === 'weekly' ? 7 : w.period === 'monthly' ? 4 : 5
  const body = v ? ws.map((w, i) => lane(14 + i * 48, 22, 200, w, ticks(w), names(w, true), true)).join('')
    : ws.map((w, i) => lane(4, 20 + i * 58, 240, w, ticks(w), names(w, false), false)).join('')
  // 주간 시간축 안에서 현재 5시간 창의 위치를 괄호로 표시해 두 주기의 포함 관계를 보여 준다.
  const bracket = v || !m.ww || !m.w5 || m.w5.period !== '5h' || m.ww.elapsed === null || m.w5.elapsed === null ? '' : (() => {
    const px = 4 + 240 * m.ww!.elapsed!, wd = Math.max(3, 240 * 5 / 168), x0 = px - wd * m.w5!.elapsed!
    return `<path d="M${x0.toFixed(1)} 33v3h${wd.toFixed(1)}v-3" stroke="var(--accent)" fill="none" stroke-width="1"/><path d="M${x0.toFixed(1)} 36 L4 74 M${(x0 + wd).toFixed(1)} 36 L244 74" stroke="var(--accent)" stroke-width=".6" opacity=".3" fill="none"/>`
  })()
  const key = b.h > (v ? 200 : 120) && b.w >= 150 ? `<div class="cap" style="text-align:center"><i class="dot" style="background:var(--svg-elapsed)"></i>지난 시간 <i class="dot" style="background:${hex(m.brand)};margin-left:10px"></i>${x.showUsed ? '사용량' : '남은 양'}</div>` : ''
  return `<div class="tl-wrap"><div class="svgwrap"><svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${body}${bracket}</svg></div>${key}</div>`
}
function batterySVG(m: ServiceModel, x: ViewContext, w: QuotaWindow, height: number, cells: number, vert: boolean) {
  const filled = Math.round(shown(x, w) / 100 * cells), c = color(x, m, w), g = 1.4
  const W = vert ? height * .5 : height * 4.4, H = vert ? height * 2.2 : height, cs: string[] = []
  for (let i = 0; i < cells; i++) {
    const on = i < filled
    if (vert) { const ch = (H - 5 - g * (cells - 1)) / cells; cs.push(`<rect x="2.5" y="${2.5 + (cells - 1 - i) * (ch + g)}" width="${W - 5}" height="${ch}" rx=".8" fill="${on ? c : 'var(--svg-track)'}"/>`) }
    else { const cw = (W - 5 - g * (cells - 1)) / cells; cs.push(`<rect x="${2.5 + i * (cw + g)}" y="2.5" width="${cw}" height="${H - 5}" rx=".8" fill="${on ? c : 'var(--svg-track)'}"/>`) }
  }
  const cap = vert ? `<rect x="${W / 2 - W * .22}" y="-3.5" width="${W * .44}" height="3" rx="1" fill="var(--svg-outline)"/>` : `<rect x="${W + 1}" y="${H / 2 - H * .2}" width="2.5" height="${H * .4}" rx="1" fill="var(--svg-outline)"/>`
  return `<svg width="${Math.round(W + (vert ? 0 : 4))}" height="${Math.round(H + (vert ? 4 : 0))}" viewBox="0 ${vert ? -4 : 0} ${W + (vert ? 0 : 4)} ${H + (vert ? 4 : 0)}" style="flex-shrink:0;overflow:visible" aria-hidden="true"><rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="2.5" fill="none" stroke="var(--svg-outline)"/>${cap}${cs.join('')}</svg>`
}
function battery(m: ServiceModel, x: ViewContext, b: { w: number; h: number; o: 'h' | 'v' }) {
  const { main, other } = pickWindow(m, x.source(m.id)), v = b.o === 'v'
  const sc = Math.max(.5, Math.min(1.5, v ? Math.min(b.h / 200, b.w / 110) : Math.min(b.w / 230, b.h / 52)))
  const one = (w: QuotaWindow, k: number) => `<div class="lg" style="align-items:${v ? 'center' : 'flex-start'};gap:5px">${batterySVG(m, x, w, (v ? 40 : 22) * sc * k, 10, v)}<span class="lbl">${w.label} <b class="num" style="color:${valColor(x, w)}">${shown(x, w)}%</b></span></div>`
  return `<div class="svgwrap" style="flex-direction:row;align-items:${v ? 'flex-end' : 'center'};gap:${v ? 16 : 20}px">${one(main, 1)}${other ? one(other, .7) : ''}</div>`
}
const FULL = { numeral, bars, rings, timeline, battery }

/* ---------- 작은 카드 형태 ----------
   원칙: 각 디자인을 알아보게 하는 그림(큰 숫자·막대·링·시간축·배터리 칸)은 끝까지 남기고, 글자·보조 정보부터 덜어 낸다. */
function laneSVG(m: ServiceModel, x: ViewContext, w: QuotaWindow, minWidth: number, h: number) {
  // 위 줄 = 리셋 주기에서 지난 시간, 아래 줄 = 남은 양, 흰 눈금 = 지금. 가로는 칸을 끝까지 채운다(눈금 굵기는 유지).
  const th = Math.max(3, Math.round(h * .42)), el = 100 * (w.elapsed ?? 0)
  return `<svg viewBox="0 0 100 ${h}" preserveAspectRatio="none" height="${h}" style="display:block;width:100%;min-width:${Math.round(Math.min(minWidth, 40))}px" aria-hidden="true"><rect width="100" height="${th}" fill="var(--svg-track)"/><rect width="${el}" height="${th}" fill="var(--svg-elapsed)"/><rect y="${h - th}" width="100" height="${th}" fill="var(--svg-track)"/><rect y="${h - th}" width="${shown(x, w)}" height="${th}" fill="${color(x, m, w)}"/>${w.elapsed === null ? '' : `<line x1="${el}" x2="${el}" y1="0" y2="${h}" stroke="var(--svg-tick)" stroke-width="1.4" opacity=".85" vector-effect="non-scaling-stroke"/>`}</svg>`
}
type C = { w: number; h: number }
const COMPACT: Record<DesignId, (m: ServiceModel, x: ViewContext, c: C, v: boolean) => string> = {
  numeral(m, x, c, v) {
    const { main, other } = pickWindow(m, x.source(m.id))
    if (v) return `<div class="c-num">${num(x, main, Math.max(22, Math.min(c.w * .42, c.h * .34, 46)))}${c.h >= 90 ? `<span class="cap" style="margin-top:5px">${main.label}</span>` : ''}</div>${c.h >= 130 && other ? `<span class="cap num" style="color:${valColor(x, other)}">${other.label} ${shown(x, other)}%</span>` : ''}`
    const size = Math.max(18, Math.min(c.h * .7, 40)), sub = c.w >= 230 && c.h >= 32 && other
    return `<div class="c-num ${c.h < 46 ? 'inline' : ''}">${c.w >= 110 ? `<span class="cap">${main.label}</span>` : ''}${num(x, main, size)}</div>${sub ? `<span class="c-sep"></span><div class="c-sub"><span class="cap">${other!.label}</span>${smallVal(x, other!)}</div>` : ''}`
  },
  bars(m, x, c, v) {
    const { main } = pickWindow(m, x.source(m.id)), ws = windowsOf(m)
    if (v) return `<div class="c-vbars">${ws.map(w => `<div class="vbar">${bar(x, m, w, true)}<span class="num row-val" style="font-size:12px;color:${valColor(x, w)}">${shown(x, w)}</span>${c.h >= 120 ? `<span class="cap">${w.short}</span>` : ''}</div>`).join('')}</div>`
    // 아주 작으면 숫자 아래에 막대, 그만큼 높이가 없으면 막대 옆에 숫자.
    if (c.w < 110) return c.h >= 30 ? `<div class="c-under">${num(x, main, 14)}${bar(x, m, main)}</div>` : `<div class="c-row nocap" style="flex:1;grid-template-columns:1fr auto">${bar(x, m, main)}${num(x, main, 13)}</div>`
    const two = c.h >= 33 && c.w >= 140, cap = c.w >= 140, reset = c.w >= 420
    const r = (w: QuotaWindow) => `<div class="c-row ${cap ? '' : 'nocap'} ${reset ? 'reset' : ''}">${cap ? `<span class="cap">${c.w >= 260 ? w.label : w.short}</span>` : ''}${bar(x, m, w)}${smallVal(x, w)}${reset ? `<span class="cap">${fmtDurationShort(w.resetMs)}</span>` : ''}</div>`
    return `<div class="c-rows">${(two ? ws : [main]).map(r).join('')}</div>`
  },
  rings(m, x, c, v) {
    const { main } = pickWindow(m, x.source(m.id))
    if (v) { const size = Math.min(c.w, c.h - (c.h >= 120 ? 36 : 0)); return `${ringSVG(m, x, size, size >= 40 ? main : null, size < 44 ? 9 : 7, false)}${c.h >= 120 ? `<div class="c-legend" style="align-items:center"><div>${windowsOf(m).map(w => `<span class="cap">${w.short}</span><span class="num" style="color:${valColor(x, w)}">${shown(x, w)}%</span>`).join('')}</div></div>` : ''}` }
    const size = Math.max(18, Math.min(c.h, 64)), legend = c.w >= size + 170 && c.h >= 34
    const lg = legend ? `<div class="c-legend">${[m.ww, m.w5].filter(Boolean).map(w => `<div><i class="dot" style="background:${color(x, m, w!)}"></i><span class="cap">${w!.label}</span>${smallVal(x, w!)}</div>`).join('')}</div>` : ''
    // 링 옆에 자리가 있으면 숫자를 밖에 크게, 없으면 링 안에 넣는다.
    const beside = !legend && (c.w >= size + 56 || size < 40)
    return `${ringSVG(m, x, size, !legend && !beside ? main : null, size < 44 ? 9 : 7, false)}${lg}${beside ? num(x, main, Math.max(16, Math.min(26, c.h * .55))) : ''}`
  },
  timeline(m, x, c, v) {
    const { main } = pickWindow(m, x.source(m.id)), ws = [m.ww, m.w5].filter(Boolean) as QuotaWindow[]
    if (v) {
      const lane = (w: QuotaWindow) => {
        const len = c.h - (c.h >= 120 ? 40 : 22), el = len * (w.elapsed ?? 0), fuel = len * shown(x, w) / 100
        return `<div class="vbar"><svg width="18" height="${len}" aria-hidden="true"><rect width="7" height="${len}" fill="var(--svg-track)" rx="1"/><rect y="${len - el}" width="7" height="${el}" fill="var(--svg-elapsed)" rx="1"/><rect x="10" width="7" height="${len}" fill="var(--svg-track)" rx="1"/><rect x="10" y="${len - fuel}" width="7" height="${fuel}" fill="${color(x, m, w)}" rx="1"/>${w.elapsed === null ? '' : `<line x1="-2" x2="20" y1="${len - el}" y2="${len - el}" stroke="var(--svg-tick)" stroke-width="1.2" opacity=".8"/>`}</svg><span class="num" style="font-size:12px;font-weight:650;color:${valColor(x, w)}">${shown(x, w)}</span>${c.h >= 120 ? `<span class="cap">${w.short}</span>` : ''}</div>`
      }
      return `<div class="c-vbars">${ws.map(lane).join('')}</div>`
    }
    if (c.w < 110) return c.h >= 30 ? `<div class="c-under">${num(x, main, 14)}${laneSVG(m, x, main, c.w, 8)}</div>` : `<div class="c-row nocap" style="flex:1;grid-template-columns:1fr auto">${laneSVG(m, x, main, Math.max(24, c.w - 40), Math.min(12, c.h - 6))}${num(x, main, 13)}</div>`
    const two = c.h >= 33 && c.w >= 140, cap = c.w >= 140, reset = c.w >= 420, lh = two ? 10 : Math.max(6, Math.min(14, c.h - 10))
    const r = (w: QuotaWindow) => `<div class="c-row ${cap ? '' : 'nocap'} ${reset ? 'reset' : ''}">${cap ? `<span class="cap">${w.short}</span>` : ''}${laneSVG(m, x, w, 40, lh)}${smallVal(x, w)}${reset ? `<span class="cap">${fmtDurationShort(w.resetMs)}</span>` : ''}</div>`
    return `<div class="c-rows">${(two ? ws : [main]).map(r).join('')}</div>`
  },
  battery(m, x, c, v) {
    const { main, other } = pickWindow(m, x.source(m.id))
    if (v) {
      const h = Math.max(12, Math.min(c.w * .42, (c.h - (c.h >= 110 ? 36 : 16)) / 2.2))
      return `<div class="c-bats">${[[main, 1], ...(other ? [[other, .72]] : [])].map(([w, k]) => `<div class="c-bat">${batterySVG(m, x, w as QuotaWindow, h * (k as number), 10, true)}${c.h >= 90 ? `<span class="num" style="font-size:12px;color:${valColor(x, w as QuotaWindow)}">${shown(x, w as QuotaWindow)}%</span>` : ''}</div>`).join('')}</div>`
    }
    // 길면 두 배터리를 양옆으로, 짧으면 하나만, 아주 작으면 글자 없이 배터리만.
    let h = Math.max(10, Math.min(c.h * .5, 22, (c.w - 52) / 4.6))
    const hTwo = Math.min(h, (c.w - 104) / 7.4), two = !!other && hTwo >= 13, text = c.w >= 100
    if (two) h = hTwo
    const one = (w: QuotaWindow, k: number) => `<div class="c-bat">${c.w >= 360 ? `<span class="cap">${w.label}</span>` : ''}${batterySVG(m, x, w, h * k, 10, false)}${text ? `<span class="num" style="font-size:${k < 1 ? 12 : 14}px;color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span>` : ''}</div>`
    return `<div class="c-bats">${one(main, 1)}${two ? one(other!, .72) : ''}</div>`
  },
  rich(m, x, c, v) {
    const { main } = pickWindow(m, x.source(m.id)), w = worstWindow(m)
    const status = w.runsOut ? { t: `${w.short} ${fmtDurationShort(w.toEmptyMs)} 뒤 소진`, hot: paceWarning(w) || w.left <= x.warn } : w.left <= x.warn ? { t: `${w.label} ${w.left}% 남음`, hot: true } : { t: windowsOf(m).length > 1 ? '두 한도 여유' : '여유', hot: false }
    if (v) return `<div class="c-num">${num(x, main, Math.max(22, Math.min(c.w * .4, c.h * .3, 44)))}<span class="cap" style="margin-top:4px">${main.label}</span></div>${c.h >= 110 ? `<span class="c-status ${status.hot ? 'hot' : ''}" style="white-space:normal;text-align:center">${status.t}</span>` : ''}`
    const size = Math.max(20, Math.min(c.h * .66, 38))
    // 종합의 정체성은 '큰 숫자 + 상태'. 넓으면 두 한도 막대를 덧붙인다.
    if (c.w >= 330 && c.h >= 34) {
      const r = (ww: QuotaWindow) => `<div class="c-row ${c.w >= 460 ? 'reset' : ''}"><span class="cap">${ww.short}</span>${bar(x, m, ww)}${smallVal(x, ww)}${c.w >= 460 ? `<span class="cap">${fmtDurationShort(ww.resetMs)}</span>` : ''}</div>`
      return `<div class="c-num">${c.h >= 46 ? `<span class="cap">${main.label}</span>` : ''}${num(x, main, size)}</div><span class="c-sep"></span><div class="c-rows">${windowsOf(m).map(r).join('')}</div>`
    }
    // 좁으면: 높이가 되면 숫자 아래 상태 문장, 아주 작으면 숫자 옆에 두 한도를 가는 막대로(숫자 디자인과 구분).
    const micro = `<div class="c-micro">${windowsOf(m).map(ww => bar(x, m, ww)).join('')}</div>`
    if (c.h >= 44) return `<div class="c-num" style="align-items:center">${num(x, main, Math.min(size, 30))}${c.w >= 110 ? `<span class="c-status ${status.hot ? 'hot' : ''}" style="margin-top:5px">${status.t}</span>` : micro}</div>`
    return `${c.w >= 190 ? `<span class="c-status ${status.hot ? 'hot' : ''}" style="flex:1;text-align:right">${status.t}</span>` : micro}<div class="c-num inline">${num(x, main, size)}</div>`
  },
}

/* ---------- 카드 ---------- */
const logo = (u: AccountUsage, x: ViewContext) => `<span class="logo">${renderAiIcon(u.provider, u.name, x.iconStyle, 18)}</span>`
const cardAttrs = (u: AccountUsage, sev: string, cls: string, style = '') =>
  `class="ucard ${cls} ${sev ? 'sev-' + sev : ''} ${u.status === 'stale' ? 'is-stale' : ''}" data-card="${esc(u.id)}" draggable="true" style="--brand:${hex(u.brandColor)};${style}"`
const titleOf = (u: AccountUsage, m: ServiceModel) => esc(`${u.name} · ${windowsOf(m).map(w => `${w.label} ${w.left}% 남음`).join(' · ')}${u.status === 'stale' ? ' · 갱신 지연' : ''}`)

function offlineCard(u: AccountUsage, x: ViewContext, box: { w: number; h: number }, style: string) {
  const msg = u.status === 'loading' ? '확인 중' : '연결 안 됨'
  const compact = box.h < 90
  return `<div ${cardAttrs(u, '', compact ? 'compact is-offline center' : 'is-offline', style)} title="${esc(u.errorMessage || msg)}">${compact
    ? `<div class="c-id">${logo(u, x)}${box.w >= 220 ? `<span class="svc">${esc(u.name)}</span>` : ''}</div><div class="c-main"><span class="c-status">${msg}</span></div>`
    : `<div class="card-head">${logo(u, x)}<span class="svc">${esc(u.name)}</span></div><div class="body offline-body"><span class="lbl">${msg}</span>${box.h >= 140 && u.errorMessage ? `<span class="cap offline-detail">${esc(u.errorMessage)}</span>` : ''}</div>`}</div>`
}

function compactCard(u: AccountUsage, m: ServiceModel, design: DesignId, x: ViewContext, box: { w: number; h: number }, style: string) {
  const sev = severity(m, x.warn, x.crit)
  // 높이는 넉넉한데 폭이 좁은 작은 카드: 위에 로고와 숫자, 아래에 그림을 카드 폭 전체로(길이가 정체성인 디자인).
  if (['bars', 'timeline', 'battery'].includes(design) && box.h >= 70 && box.w >= 140 && box.w < 220 && box.h <= box.w * 1.25) {
    const { main, other } = pickWindow(m, x.source(m.id)), W = box.w - 24
    const vals = design === 'battery' ? `${smallVal(x, main)}${other ? `<span class="cap">${other.label} ${shown(x, other)}%</span>` : ''}`
      : windowsOf(m).map(w => `${W >= 120 ? `<span class="cap">${w.short}</span>` : ''}${smallVal(x, w)}`).join('')
    const art = design === 'battery' ? `<div style="display:flex">${batterySVG(m, x, main, Math.min(18, (W - 6) / 4.4), 10, false)}</div>`
      : windowsOf(m).map(w => design === 'bars' ? bar(x, m, w) : laneSVG(m, x, w, W, 10)).join('')
    return `<div ${cardAttrs(u, sev, 'compact cs', style)} title="${titleOf(u, m)}"><div class="cs-top">${logo(u, x)}<div class="cs-vals">${vals}</div></div><div class="cs-art">${art}</div></div>`
  }
  const v = box.h > box.w * 1.25 && box.w < 170, c = { w: box.w - (v ? 16 : 24), h: box.h - (v ? 20 : 12) }
  // 그림이 넓게 필요한 디자인일수록 이름을 늦게 보인다.
  const nameShown = !v && c.w >= ({ numeral: 240, rich: 250, rings: 300, battery: 340, bars: 380, timeline: 380 } as Record<DesignId, number>)[design]
  const idW = v ? 0 : 18 + (nameShown ? Math.min(120, u.name.length * 7 + 7) : 0) + 12
  return `<div ${cardAttrs(u, sev, `compact ${v ? 'cv' : ''} ${!v && !nameShown ? 'center' : ''}`, style)} title="${titleOf(u, m)}"><div class="c-id">${logo(u, x)}${nameShown ? `<span class="svc">${esc(u.name)}</span>` : ''}</div><div class="c-main">${COMPACT[design](m, x, { w: c.w - idW, h: c.h }, v)}</div></div>`
}

/** 카드 하나. box는 격자 칸 크기(px). */
export function renderCard(u: AccountUsage, design: DesignId, x: ViewContext, box: { w: number; h: number }, style = '') {
  const m = serviceModel(u)
  if (!m.available || !windowsOf(m).length) return offlineCard(u, x, box, style)
  if (formOf(design, box.w, box.h) === 'compact') return compactCard(u, m, design, x, box, style)
  const sev = severity(m, x.warn, x.crit), lo = Math.min(...windowsOf(m).map(w => w.left))
  const { bw, bh } = cardBody(box.w, box.h), narrow = box.w < 210
  const flag = !sev ? '' : `<span class="flag" title="${lo <= x.warn ? `여유 ${lo}%` : '이 속도면 리셋 전에 소진'}"><i></i>${narrow ? (lo <= x.warn ? lo + '%' : '!') : lo <= x.warn ? `여유 ${lo}%` : '속도 주의'}</span>`
  const tier = design === 'rich' ? richTier(bw, bh) : ''
  const multi = windowsOf(m).length > 1
  const showSrc = multi && box.w >= 150 && (['numeral', 'rings', 'battery'].includes(design) || (design === 'rich' && ['mw', 'l', 'lw', 'tall', 'ml'].includes(tier)))
  const o = design === 'rich' ? 'h' : fitDesign(design, bw, bh).o
  const foot = x.showReset && ['numeral', 'bars', 'battery', 'rings'].includes(design) && bh > 110
    ? `<div class="foot">${windowsOf(m).filter(w => w.resetMs !== null).map((w, i) => i === 0 || box.w > 260 ? `<span>${box.w >= 200 ? `${w.label} 리셋 ${fmtDuration(w.resetMs)}` : `${w.short} ${fmtDurationShort(w.resetMs)}`}</span>` : '').join('')}</div>` : ''
  // 이름이 가장 중요하다. 좁으면 줄임표로 줄여서라도 남기고, 정말 좁을 때만 뺀다.
  const nameShown = box.w > (flag ? (showSrc ? 190 : 160) : 120)
  const body = design === 'rich' ? rich(m, x, { w: bw, h: bh }) : FULL[design](m, x, { w: bw, h: Math.max(20, bh - (foot ? 18 : 0)), o })
  return `<div ${cardAttrs(u, sev, '', style)} title="${titleOf(u, m)}">
    <div class="card-head">${logo(u, x)}${nameShown ? `<span class="svc">${esc(u.name)}</span>` : ''}${flag}${showSrc ? `<button class="src" data-src="${esc(u.id)}" title="큰 숫자 기준" aria-haspopup="menu">${({ weekly: '주간', '5h': u.primaryKind === 'monthly' ? '월간' : '5시간', tight: '빠듯한 쪽' })[x.source(u.id)]}${chev}</button>` : ''}</div>
    <div class="body">${body}</div>${foot}</div>`
}
