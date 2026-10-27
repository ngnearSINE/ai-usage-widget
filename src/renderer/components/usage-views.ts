import type { AccountUsage, HistoryPoint, WidgetConfig } from '../../common/types.js'
import {
  cardBody, fitDesign, lowestLeft, fmtDuration, fmtDurationShort, formOf, paceWarning, pickWindow, richScale, richTier, serviceModel, severity, unusedWeekly, windowsOf, worstWindow,
  type DesignId, type QuotaWindow, type ServiceModel, type ValueSource, TIER_NEED } from '../../common/usage-model.js'
import { renderAiIcon } from './ai-icons.js'
import { barColor, heatOf, type ColorMode } from '../../common/bar-color.js'
import { displayOf } from '../../common/display-options.js'
import { staleTip } from '../../common/stale-notice.js'

/** 대시보드 카드 렌더러. 디자인마다 기본 형태와 작은 카드 형태가 있고, 작아져도 다른 디자인으로 바꿔 그리지 않는다. */
export interface ViewContext {
  warn: number
  crit: number
  showPace: boolean
  showReset: boolean
  showUsed: boolean
  colorByUsage: boolean
  colorMode: ColorMode
  heatOn: boolean
  iconStyle: WidgetConfig['iconStyle']
  source: (id: string) => ValueSource
  /** 서비스별 보여 줄 정보(없으면 위의 전체 값) */
  per?: (id: string) => { showUsed: boolean; showPace: boolean; showReset: boolean }
  history?: Record<string, HistoryPoint[]>
}
export function viewContext(config: WidgetConfig, history?: Record<string, HistoryPoint[]>): ViewContext {
  const warn = Math.max(1, Math.min(60, config.warnPercent ?? 20))
  return {
    warn, crit: Math.max(0, Math.min(warn, config.critPercent ?? 10)), showPace: config.showPace !== false,
    showReset: config.showResetTime !== false, showUsed: !!config.showUsedPercent, colorByUsage: config.colorByUsage !== false,
    // 막대 색 기본은 '부드럽게': 카드 배경 경고색과 같은 시점(여유 50%)부터 막대도 바뀐다
    colorMode: config.colorMode === 'step' ? 'step' : 'smooth', heatOn: config.warnTint !== false, iconStyle: config.iconStyle, source: id => config.valueSource?.[id] || 'weekly', history,
    per: id => displayOf(config, id),
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
const base = (m: ServiceModel) => m.bar || hex(m.brand)
const color = (x: ViewContext, m: ServiceModel, w: QuotaWindow) => barColor(w.left, base(m), { on: x.colorByUsage, mode: x.colorMode, warn: x.warn, crit: x.crit })
const valColor = (x: ViewContext, w: QuotaWindow) => x.colorByUsage && w.left <= x.warn ? (w.left <= x.crit ? 'var(--danger)' : 'var(--warn)') : 'var(--ink)'
const remainWord = (x: ViewContext) => x.showUsed ? '사용' : '남음'

/* ---------- 마우스 설명: 요소마다 무엇인지와 값, 카드에는 작아서 생략된 정보 ---------- */
const clock = (ms: number) => {
  const d = new Date(Date.now() + ms), p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()}(${'일월화수목금토'[d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}`
}
const amountWord = (x: ViewContext) => x.showUsed ? '사용한 양' : '남은 양'
const resetLine = (w: QuotaWindow) => w.resetMs === null ? '리셋 시각 정보 없음' : `리셋 ${fmtDuration(w.resetMs)} 뒤 · ${clock(w.resetMs)}`
export function tipWindow(m: ServiceModel, w: QuotaWindow, x: ViewContext) {
  return [`${w.label} ${amountWord(x)} ${shown(x, w)}% (막대)`, resetLine(w), noteOf(w, x).t, m.name].join('\n')
}
export function tipPace(w: QuotaWindow, x: ViewContext) {
  if (w.expectedLeft === null) return ''
  const diff = w.left - w.expectedLeft
  return [`${w.label} 페이스 기준 (흰 눈금)`, `고르게 썼다면 지금 ${x.showUsed ? `${100 - w.expectedLeft}% 썼어야` : `${w.expectedLeft}% 남아 있어야`} 해요`,
    diff >= 0 ? `지금은 기준보다 ${diff}%p 여유 있게 쓰는 중` : `지금은 기준보다 ${-diff}%p 빨리 쓰는 중`].join('\n')
}
export function tipOther(w: QuotaWindow, x: ViewContext) {
  return [`${w.label} ${amountWord(x)} ${shown(x, w)}% (색 눈금)`, resetLine(w), noteOf(w, x).t].join('\n')
}
const hhmm = (iso: string) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '' }
function cardTip(u: AccountUsage, m: ServiceModel, x: ViewContext) {
  const h = headline(m, x)
  return esc([...(u.pending ? [PENDING_TIP, ''] : u.status === 'stale' ? [staleTip(u), ''] : []), u.name, u.tier || '', ...[...windowsOf(m), ...m.scoped].map(w => `${w.label} ${shown(x, w)}% ${x.showUsed ? '사용' : '남음'} · ${w.resetMs === null ? '리셋 정보 없음' : `리셋 ${fmtDurationShort(w.resetMs)} 뒤`}`),
    h.t, `${u.status === 'stale' ? '마지막으로 받은 시각' : '확인'} ${hhmm(u.updatedAt)}`].filter((v, i, a) => v !== '' || (i > 0 && a[i - 1] !== '')).join('\n'))
}

const bar = (x: ViewContext, m: ServiceModel, w: QuotaWindow, vert = false) => {
  const e = x.showPace ? expected(x, w) : null, pt = esc(tipPace(w, x))
  return `<div class="track" data-tip="${esc(tipWindow(m, w, x))}"><div class="fill" style="--c:${color(x, m, w)};${vert ? `height:${shown(x, w)}%` : `width:${shown(x, w)}%`}"></div>${e === null ? '' : vert ? `<i class="pace" data-tip="${pt}" style="bottom:calc(${e}% - 1px)"></i>` : `<i class="pace" data-tip="${pt}" style="left:calc(${e}% - 1px)"></i>`}</div>`
}
/**
 * 한 줄 막대: 막대 = 큰 숫자 기준 한도, 흰 눈금 = 그 한도의 페이스, 막대 아래 가는 보조 막대 = 다른 한도(보통 5시간).
 * 이름이 빠지는 작은 카드에서 두 줄 대신 쓴다. 보조 표시는 막대 위로 튀어나오지 않게 아래에 두어 위쪽 숫자와 겹치지 않는다.
 */
const bar1 = (x: ViewContext, m: ServiceModel) => {
  const { main, other } = pickWindow(m, x.source(m.id))
  if (!other) return bar(x, m, main)
  const sub = `<div class="sub-bar" data-tip="${esc(tipOther(other, x))}"><i style="width:${shown(x, other)}%;--c:${color(x, m, other)}"></i></div>`
  return bar(x, m, main).replace(/<\/div>$/, `${sub}</div>`).replace('class="track"', 'class="track with-sub"')
}
const num = (x: ViewContext, w: QuotaWindow, size: number) =>
  `<span class="big" style="font-size:${Math.round(size)}px;color:${valColor(x, w)}">${shown(x, w)}<span class="unit" style="font-size:${Math.round(size * .44)}px">%</span></span>`
const smallVal = (x: ViewContext, w: QuotaWindow) => `<span class="num" style="color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span>`

function headline(m: ServiceModel, x: ViewContext) {
  const w = worstWindow(m)
  if (!w) return { t: '', hot: false }
  // 짧게: 언제 무엇이 일어나는지를 앞에
  // '예상 시간'을 끄면 속도로 짐작한 문구(소진 예상)는 빼고 남은 양만 말한다.
  const pace = x.showPace
  if (pace && paceWarning(w)) return { t: `${fmtDuration(w.toEmptyMs)} 후 ${w.label} 한도 소진 예상`, hot: true }
  if (w.left <= x.warn) return { t: `${w.label} 여유 ${w.left}%`, hot: true }
  const unused = unusedWeekly(m)
  if (unused) return { t: `${fmtDuration(unused.resetMs)} 후 주간 여유 ${unused.left}% 초기화`, hot: false }
  if (pace && w.runsOut) return { t: `${fmtDuration(w.toEmptyMs)} 후 ${w.label} 한도 소진 예상`, hot: false }
  return { t: windowsOf(m).length > 1 ? '두 한도 모두 여유' : '여유', hot: false }
}
function noteOf(w: QuotaWindow, x: ViewContext) {
  if (w.used === 0) return { t: '아직 쓰지 않음', hot: false }
  if (x.showPace && w.runsOut) return { t: `${fmtDuration(w.toEmptyMs)} 후 소진(예상)`, hot: paceWarning(w) }
  if (x.showPace && w.pace !== null && w.pace > 1.15) return { t: '시간보다 빠르게 쓰는 중', hot: false }
  return { t: w.elapsed === null ? '리셋 시각 정보 없음' : '여유', hot: false }
}

/** 넓은 카드의 한도 이름: 세션(5시간)·주간 · 전체 모델·주간 · Fable */
function fullLabel(m: ServiceModel, w: QuotaWindow) {
  if (m.scoped.includes(w)) return `주간 · ${w.label}`
  if (w.period === '5h') return '세션 (5시간)'
  if (w.key === 'weekly' && m.scoped.length) return '주간 · 전체 모델'
  return w.label
}
/** 리셋 시각: 하루 안이면 시:분, 넘으면 월/일(요일) 시:분 */
function resetClock(ms: number) {
  const d = new Date(Date.now() + ms), p = (n: number) => String(n).padStart(2, '0')
  return ms < 20 * 3600e3 ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}(${'일월화수목금토'[d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}`
}
/** 속도 칩: 고르게 썼을 때보다 얼마나 남았는지(주기의 3%가 지나기 전에는 숨김). */
function paceChip(w: QuotaWindow) {
  if (w.expectedLeft === null || w.elapsed === null || w.elapsed < .03) return ''
  const d = Math.round(w.left - w.expectedLeft)
  if (Math.abs(d) < 3) return '<span class="pace-chip even" data-tip="고르게 쓰는 속도와 비슷해요">적정</span>'
  return d > 0 ? `<span class="pace-chip good" data-tip="고르게 썼을 때보다 ${d}% 더 남았어요">여유 +${d}%</span>` : `<span class="pace-chip hot" data-tip="고르게 썼을 때보다 ${-d}% 더 썼어요">빠름 ${d}%</span>`
}

/* ---------- 종합: 크기 단계 ---------- */
function rich(m: ServiceModel, x: ViewContext, b: { w: number; h: number }) {
  const t = richTier(b.w, b.h), { main } = pickWindow(m, x.source(m.id)), h = headline(m, x), ws = windowsOf(m)
  const k = ['mw', 'ml', 'l', 'lw'].includes(t) ? richScale(b.w, b.h) : 1
  const big = (size: number) => num(x, main, size)
  // 줄이 실제로 쓰는 폭: 큰 숫자가 왼쪽에 있는 넓은 카드는 오른쪽 절반쯤만 쓴다.
  const rowW = ['l', 'lw', 'ml'].includes(t) ? b.w * .55 : b.w
  // '보여 줄 정보 → 리셋 시간'을 끄면 종합 카드에서도 리셋 문구를 뺀다
  const resetText = (w: QuotaWindow) => w.resetMs === null || !x.showReset ? '' : rowW >= 260 ? `리셋 ${fmtDuration(w.resetMs)} 뒤` : rowW >= 150 ? fmtDurationShort(w.resetMs) : ''
  const row = (w: QuotaWindow, withNote: boolean) => {
    const n = noteOf(w, x), wide = rowW >= 240
    // 넓으면: 윗줄 = 이름·속도 칩·숫자, 막대 아래 줄 = 메모(왼쪽)·리셋까지 남은 시간과 시각(오른쪽)
    if (wide && withNote) return `<div class="row"><div class="row-top wide"><span class="lbl">${esc(fullLabel(m, w))}</span>${x.showPace ? paceChip(w) : ''}<span class="row-val num" style="color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span></div>${bar(x, m, w)}<div class="row-sub"><span class="row-note ${n.hot ? 'hot' : ''}" data-tip="${n.t}">${n.t}</span>${w.resetMs === null || !x.showReset ? '' : `<span class="cap row-reset">리셋 : ${fmtDurationShort(w.resetMs)} 뒤 · ${resetClock(w.resetMs)}</span>`}</div></div>`
    return `<div class="row"><div class="row-top"><span class="lbl">${wide ? esc(fullLabel(m, w)) : esc(w.label)}</span>${wide && x.showPace ? paceChip(w) : ''}<span class="row-val num" style="color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span><span class="cap row-reset">${resetText(w)}</span></div>${bar(x, m, w)}${withNote ? `<div class="row-note ${n.hot ? 'hot' : ''}">${n.t}</div>` : ''}</div>`
  }
  const inline = (w: QuotaWindow, reset: boolean) => `<div class="inline-row ${reset ? 'with-reset' : ''}"><span class="lbl">${w.label}</span>${bar(x, m, w)}<span class="row-val num" style="color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span>${reset ? `<span class="cap">${w.resetMs === null ? '' : fmtDurationShort(w.resetMs)}</span>` : ''}</div>`
  // 모델 전용 주간 한도(Fable 등)는 큰 카드에 줄을 더한다. 자리가 모자라면 덜 중요한 글부터 뺀다:
  // 줄 아래 메모(줄마다 약 14px) → 상태 문장(약 30px). 그래도 안 되면 설명 창에만 둔다.
  const spare = b.h - (TIER_NEED[t] ?? b.h) * Math.min(richScale(b.w, b.h), 1.35)
  const plan = (note: boolean, head: boolean) => {
    const tries: Array<[boolean, boolean]> = [[note, head], [false, head], [false, false]]
    for (const [cn, ch] of tries) {
      const room = spare + (note && !cn ? ws.length * 14 : 0) + (head && !ch && h.t ? 30 : 0)
      const n = Math.min(m.scoped.length, Math.floor(room / (cn ? 46 : 32)))
      if (n >= 1) return { note: cn, head: ch, extra: m.scoped.slice(0, n) }
    }
    return { note, head, extra: [] as QuotaWindow[] }
  }
  const rows = (p: { note: boolean; extra: QuotaWindow[] }) => [...ws, ...p.extra].map(w => row(w, p.note)).join('')
  const sum = (size: number, head: boolean, extra = '') => `<div class="rich-sum">${big(size)}<div class="lbl sub" ${extra}>${main.label} ${remainWord(x)}</div>${head && h.t ? `<div class="rich-head ${h.hot ? 'hot' : ''}">${esc(h.t)}</div>` : ''}</div>`
  const wrap = (cls: string, inner: string) => `<div style="--k:${k.toFixed(2)}" class="rich ${cls}">${inner}</div>`
  if (t === 's') return wrap('t-s', `<div class="rows">${ws.map(w => inline(w, x.showReset && b.w >= 290)).join('')}</div>`)
  if (t === 'm') return wrap('t-m', `<div class="rows">${rows(plan(false, false))}</div>`)
  if (t === 'mw') return wrap('t-mw', `${sum(Math.max(30, Math.min(b.h * .5, 48)), false)}<div class="rows">${rows(plan(false, false))}</div>`)
  if (t === 'tall') {
    const vb = (w: QuotaWindow) => `<div class="vbar">${bar(x, m, w, true)}<span class="num row-val" style="color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span><span class="cap">${w.label}</span></div>`
    return wrap('t-tall', `${sum(Math.max(28, Math.min(b.w * .36, 44)), false)}<div class="vbars">${ws.map(vb).join('')}</div>`)
  }
  // 공간이 넉넉한 넓은 카드에는 최근 24시간 추이선을 덧붙인다.
  // 하루 사이에 움직이는 것은 5시간 한도라 24시간 추이선은 5시간 한도를 우선 그린다.
  const sparkWin = m.w5 || main
  const sparkBlock = (h: number) => { const sv = spark(m, x, sparkWin, h); return sv ? `<div class="rich-spark">${sv}<span class="cap">최근 24시간 · ${sparkWin.label}</span></div>` : '' }
  if (t === 'lw') {
    const size = Math.max(38, Math.min(b.h * .42, 64 * k)), withSpark = b.h >= 140, p = plan(true, true)
    return wrap('t-lw', `<div class="rich-sum ${withSpark ? (b.h >= 175 ? 'with-spark' : 'with-spark tight') : ''}">${big(withSpark ? Math.min(size, b.h >= 175 ? 52 : 40) : size)}<div class="lbl sub">${main.label} ${remainWord(x)}</div>${p.head && h.t ? `<div class="rich-head ${h.hot ? 'hot' : ''}">${esc(h.t)}</div>` : ''}${withSpark ? sparkBlock(26) : ''}</div><div class="rows">${rows(p)}</div>`)
  }
  if (t === 'ml') { const p = plan(false, true); return wrap('t-l t-ml', `${sum(Math.max(30, Math.min(b.w * .16, b.h * .22, 44)), p.head)}<div class="rows">${rows(p)}</div>`) }
  const p = plan(true, true)
  return wrap('t-l', `${sum(Math.max(34, Math.min(b.w * .2, b.h * .22, 60 * k)), p.head)}<div class="rows">${rows(p)}</div>${b.h >= 212 * k + 56 + p.extra.length * 46 ? sparkBlock(30) : ''}`)
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
  // 모델 전용 주간 한도는 가로형에서 줄마다 약 44px가 남을 때만 덧붙인다.
  const ws = windowsOf(m), extra = v ? [] : m.scoped.slice(0, Math.max(0, Math.floor(b.h / 44) - ws.length))
  return `<div class="v-bars ${v ? 'v' : ''}">${[...ws, ...extra].map(row).join('')}</div>`
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
  // 모델 전용 한도(Fable 등)가 보이면 가장 안쪽에 고리를 하나 더(그릴 자리가 있을 때만)
  const third = inner && m.scoped[0] && size >= 70 ? m.scoped[0] : null
  const fs = third ? 16 : size < 60 ? 24 : 19
  return `<svg viewBox="0 0 100 100" width="${Math.round(size)}" height="${Math.round(size)}" style="flex-shrink:0" aria-hidden="true">${ring(42, outer)}${inner ? ring(42 - sw - 4, inner) : ''}${third ? ring(42 - 2 * (sw + 4), third) : ''}${center ? `<text x="50" y="${third ? 55.5 : size < 60 ? 58 : 55}" text-anchor="middle" fill="${valColor(x, center)}" font-size="${fs}" font-weight="650" font-family="Segoe UI Variable Display,Segoe UI" letter-spacing="-.8">${shown(x, center)}<tspan font-size="${size < 60 ? 10 : 8}" fill="var(--dim)">%</tspan></text>` : ''}</svg>`
}
function rings(m: ServiceModel, x: ViewContext, b: { w: number; h: number; o: 'h' | 'v' }) {
  const { main } = pickWindow(m, x.source(m.id)), v = b.o === 'v', side = Math.max(60, Math.min(v ? b.w : b.w * .58, v ? b.h * .74 : b.h))
  const lg = (w: QuotaWindow, where: string) => `<div class="lg"><span class="lbl"><i class="dot" style="background:${color(x, m, w)}"></i>${w.label}${v || !where ? '' : ` · ${where}`}</span><span class="num" style="color:${valColor(x, w)}">${shown(x, w)}%</span></div>`
  const third = m.ww && m.w5 && m.scoped[0] && side >= 70 ? m.scoped[0] : null
  const legend = b.w > 230 || v ? `<div class="legend">${m.ww ? lg(m.ww, m.w5 ? '바깥' : '') : ''}${m.w5 ? lg(m.w5, m.ww ? (third ? '가운데' : '안쪽') : '') : ''}${third ? lg(third, '가장 안쪽') : ''}</div>` : ''
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
  const key = b.h > (v ? 200 : 120) && b.w >= 150 ? `<div class="cap" style="text-align:center"><i class="dot" style="background:var(--svg-elapsed)"></i>지난 시간 <i class="dot" style="background:${base(m)};margin-left:10px"></i>${x.showUsed ? '사용량' : '남은 양'}</div>` : ''
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
    if (c.w < 110) return c.h >= 30 ? `<div class="c-under">${num(x, main, 14)}${bar1(x, m)}</div>` : `<div class="c-row nocap" style="flex:1;grid-template-columns:1fr auto">${bar1(x, m)}${num(x, main, 13)}</div>`
    // 두 줄 여부는 높이로만 정한다(폭으로 정하면 계정 표식이 붙은 카드만 한 줄이 되어 격자가 들쭉날쭉해진다).
    const two = c.h >= 33, cap = c.w >= 120, reset = x.showReset && c.w >= 420
    const r = (w: QuotaWindow, one = false) => `<div class="c-row ${cap ? '' : 'nocap'} ${reset ? 'reset' : ''}">${cap ? `<span class="cap">${c.w >= 260 ? w.label : w.short}</span>` : ''}${one ? bar1(x, m) : bar(x, m, w)}${smallVal(x, w)}${reset ? `<span class="cap">${fmtDurationShort(w.resetMs)}</span>` : ''}</div>`
    return `<div class="c-rows">${two ? ws.map(w => r(w)).join('') : r(main, true)}</div>`
  },
  rings(m, x, c, v) {
    const { main } = pickWindow(m, x.source(m.id))
    if (v) { const size = Math.min(c.w, c.h - (c.h >= 120 ? 36 : 0)); return `${ringSVG(m, x, size, size >= 40 ? main : null, size < 44 ? 9 : 7, false)}${c.h >= 120 ? `<div class="c-legend" style="align-items:center"><div>${windowsOf(m).map(w => `<span class="cap">${w.short}</span><span class="num" style="color:${valColor(x, w)}">${shown(x, w)}%</span>`).join('')}</div></div>` : ''}` }
    // 링은 아이콘 자리(약 30px)를 뺀 폭 안에 들어가야 한다(넘치면 아이콘과 겹치고 숫자가 잘린다).
    const avail = Math.max(18, c.w - 30)
    let size = Math.max(18, Math.min(c.h, 64, avail))
    const legend = c.w >= size + 170 && c.h >= 34
    const lg = legend ? `<div class="c-legend">${[m.ww, m.w5].filter(Boolean).map(w => `<div><i class="dot" style="background:${color(x, m, w!)}"></i><span class="cap">${w!.label}</span>${smallVal(x, w!)}</div>`).join('')}</div>` : ''
    // 링 옆에 자리가 있으면 숫자를 밖에 크게, 없으면 링 안에 넣는다. 링이 작아 안에 못 넣으면 링을 줄여 옆에 둔다.
    let beside = !legend && avail >= size + 56
    if (!legend && !beside && size < 40) { size = Math.max(16, Math.min(size, avail - 34)); beside = true }
    return `${ringSVG(m, x, size, !legend && !beside ? main : null, size < 44 ? 9 : 7, false)}${lg}${beside ? num(x, main, Math.max(13, Math.min(26, c.h * .55, (avail - size) * .45))) : ''}`
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
    const two = c.h >= 33 && c.w >= 140, cap = c.w >= 140, reset = x.showReset && c.w >= 420, lh = two ? 10 : Math.max(6, Math.min(14, c.h - 10))
    const r = (w: QuotaWindow) => `<div class="c-row ${cap ? '' : 'nocap'} ${reset ? 'reset' : ''}">${cap ? `<span class="cap">${w.short}</span>` : ''}${laneSVG(m, x, w, 40, lh)}${smallVal(x, w)}${reset ? `<span class="cap">${fmtDurationShort(w.resetMs)}</span>` : ''}</div>`
    return `<div class="c-rows">${(two ? ws : [main]).map(r).join('')}</div>`
  },
  battery(m, x, c, v) {
    const { main, other } = pickWindow(m, x.source(m.id))
    if (v) {
      const h = Math.max(12, Math.min(c.w * .42, (c.h - (c.h >= 110 ? 36 : 16)) / 2.2))
      return `<div class="c-bats">${[[main, 1], ...(other ? [[other, .72]] : [])].map(([w, k]) => `<div class="c-bat">${batterySVG(m, x, w as QuotaWindow, h * (k as number), 10, true)}${c.h >= 90 ? `<span class="num" style="font-size:12px;color:${valColor(x, w as QuotaWindow)}">${shown(x, w as QuotaWindow)}%</span>` : ''}</div>`).join('')}</div>`
    }
    // 길면 두 배터리를 양옆으로, 짧으면 하나만. 폭이 좁으면 숫자 아래에 배터리(숫자는 빼지 않는다).
    if (c.w < 100) return c.h >= 30 ? `<div class="c-under">${num(x, main, 14)}${batterySVG(m, x, main, 9, 10, false)}</div>` : `<div class="c-row nocap" style="flex:1;grid-template-columns:auto 1fr">${batterySVG(m, x, main, Math.max(8, Math.min(12, c.h - 10)), 10, false)}${num(x, main, 13)}</div>`
    let h = Math.max(10, Math.min(c.h * .5, 22, (c.w - 52) / 4.6))
    const hTwo = Math.min(h, (c.w - 104) / 7.4), two = !!other && hTwo >= 13, text = c.w >= 100
    if (two) h = hTwo
    const one = (w: QuotaWindow, k: number) => `<div class="c-bat">${c.w >= 360 ? `<span class="cap">${w.label}</span>` : ''}${batterySVG(m, x, w, h * k, 10, false)}${text ? `<span class="num" style="font-size:${k < 1 ? 12 : 14}px;color:${valColor(x, w)}">${shown(x, w)}<span class="unit">%</span></span>` : ''}</div>`
    return `<div class="c-bats">${one(main, 1)}${two ? one(other!, .72) : ''}</div>`
  },
  rich(m, x, c, v) {
    const { main } = pickWindow(m, x.source(m.id)), w = worstWindow(m)
    const status = x.showPace && w.runsOut ? { t: `${w.short} ${fmtDurationShort(w.toEmptyMs)} 뒤 소진`, hot: paceWarning(w) || w.left <= x.warn } : w.left <= x.warn ? { t: `${w.label} ${w.left}% 남음`, hot: true } : { t: windowsOf(m).length > 1 ? '두 한도 여유' : '여유', hot: false }
    if (v) return `<div class="c-num">${num(x, main, Math.max(22, Math.min(c.w * .4, c.h * .3, 44)))}<span class="cap" style="margin-top:4px">${main.label}</span></div>${c.h >= 110 ? `<span class="c-status ${status.hot ? 'hot' : ''}" style="white-space:normal;text-align:center">${status.t}</span>` : ''}`
    const size = Math.max(20, Math.min(c.h * .66, 38))
    // 종합의 정체성은 '큰 숫자 + 상태'. 넓으면 두 한도 막대를 덧붙인다.
    if (c.w >= 330 && c.h >= 34) {
      const r = (ww: QuotaWindow) => `<div class="c-row ${x.showReset && c.w >= 460 ? 'reset' : ''}"><span class="cap">${ww.short}</span>${bar(x, m, ww)}${smallVal(x, ww)}${x.showReset && c.w >= 460 ? `<span class="cap">${fmtDurationShort(ww.resetMs)}</span>` : ''}</div>`
      return `<div class="c-num">${c.h >= 46 ? `<span class="cap">${main.label}</span>` : ''}${num(x, main, size)}</div><span class="c-sep"></span><div class="c-rows">${windowsOf(m).map(r).join('')}</div>`
    }
    // 좁으면: 높이가 되면 숫자 아래 상태 문장, 아주 작으면 숫자 옆에 두 한도를 가는 막대로(숫자 디자인과 구분).
    const micro = `<div class="c-micro">${bar1(x, m)}</div>`
    if (c.h >= 44) return `<div class="c-num" style="align-items:center">${num(x, main, Math.min(size, 30))}${c.w >= 110 ? `<span class="c-status ${status.hot ? 'hot' : ''}" style="margin-top:5px">${status.t}</span>` : micro}</div>`
    return `${c.w >= 190 ? `<span class="c-status ${status.hot ? 'hot' : ''}" style="flex:1;text-align:right">${status.t}</span>` : micro}<div class="c-num inline">${num(x, main, size)}</div>`
  },
}

/* ---------- 카드 ---------- */
/**
 * 같은 서비스의 여러 계정(예: Claude 팀·개인)은 이름이 빠지는 작은 카드에서 아이콘만으로 구분되지 않는다.
 * 이름이 'Claude 팀 · 조직' 형식이면 아이콘에 짧은 표식을 붙인다(팀·엔터프라이즈는 종류, 개인은 이메일 앞 5글자).
 */
export function accountTag(name: string) {
  const m = /^\S+ (\S+) · (.+)$/.exec(name)
  if (!m) return ''
  return m[1] === '개인' ? [...m[2]].slice(0, 5).join('') : m[1] === '엔터프라이즈' ? '엔터' : m[1]
}
/** 새 값을 받지 못하는 중인 카드: 마지막 값을 보여 주는 중이거나, 연결됐던 계정이 지금 끊겼다. */
export const isOutOfDate = (u: AccountUsage) => u.status === 'stale' || (!!u.everConnected && (u.status === 'error' || u.status === 'unauthenticated'))
/** 앱을 막 켜서 마지막 값을 먼저 보여 주며 새 값을 확인하는 중일 때의 안내. */
export const PENDING_TIP = '새 값을 확인하는 중이에요.\n먼저 마지막으로 받은 값을 보여 드리고, 새 값이 오는 대로 바꿔요.'
const staleMark = (u: AccountUsage) => u.pending
  ? `<span class="stale-mark pending" data-tip="${esc(PENDING_TIP)}" aria-label="확인 중"><i></i><i></i><i></i></span>`
  : isOutOfDate(u) ? `<span class="stale-mark" data-tip="${esc(staleTip(u, Date.now(), u.status === 'stale'))}" aria-label="새 값을 받지 못하는 중">!</span>` : ''
const logo = (u: AccountUsage, x: ViewContext, tagged = true) => {
  const tag = tagged ? accountTag(u.name) : ''
  return `<span class="logo ${tag ? 'tagged' : ''}">${renderAiIcon(u.provider, u.name, x.iconStyle, 18)}${tag ? `<i class="logo-tag">${esc(tag)}</i>` : ''}${staleMark(u)}</span>`
}
const cardAttrs = (u: AccountUsage, sev: string, cls: string, style = '') =>
  `class="ucard ${cls} ${sev ? 'sev-' + sev : ''} ${u.status === 'stale' ? 'is-stale' : ''}" data-card="${esc(u.id)}" style="--brand:${hex(u.brandColor)};${style}"`

function offlineCard(u: AccountUsage, x: ViewContext, box: { w: number; h: number }, style: string) {
  const msg = u.status === 'loading' ? '확인 중' : u.everConnected ? '연결 끊김' : '연결 안 됨'
  const compact = box.h < 90
  const tip = u.status !== 'loading' && u.everConnected ? staleTip(u, Date.now(), false) : [u.name, u.errorMessage || msg].join('\n')
  return `<div ${cardAttrs(u, '', compact ? 'compact is-offline center' : 'is-offline', style)} data-tip="${esc(tip)}">${compact
    ? `<div class="c-id">${logo(u, x)}${box.w >= 220 ? `<span class="svc">${esc(u.name)}</span>` : ''}</div><div class="c-main"><span class="c-status">${msg}</span></div>`
    : `<div class="card-head">${logo(u, x)}<span class="svc">${esc(u.name)}</span></div><div class="body offline-body"><span class="lbl">${msg}</span>${box.h >= 140 && u.errorMessage ? `<span class="cap offline-detail">${esc(u.errorMessage)}</span>` : ''}</div>`}</div>`
}

function compactCard(u: AccountUsage, m: ServiceModel, design: DesignId, x: ViewContext, box: { w: number; h: number }, style: string) {
  const sev = severity(m, x.warn, x.crit, x.showPace)
  // 높이는 넉넉한데 폭이 좁은 작은 카드: 위에 로고와 숫자, 아래에 그림을 카드 폭 전체로(길이가 정체성인 디자인).
  if (['bars', 'timeline', 'battery'].includes(design) && box.h >= 70 && box.w >= 140 && box.w < 220 && box.h <= box.w * 1.25) {
    const { main, other } = pickWindow(m, x.source(m.id)), W = box.w - 24
    const vals = design === 'battery' ? `${smallVal(x, main)}${other ? `<span class="cap">${other.label} ${shown(x, other)}%</span>` : ''}`
      : windowsOf(m).map(w => `${W >= 120 ? `<span class="cap">${w.short}</span>` : ''}${smallVal(x, w)}`).join('')
    const art = design === 'battery' ? `<div style="display:flex">${batterySVG(m, x, main, Math.min(18, (W - 6) / 4.4), 10, false)}</div>`
      : windowsOf(m).map(w => design === 'bars' ? bar(x, m, w) : laneSVG(m, x, w, W, 10)).join('')
    return `<div ${cardAttrs(u, sev, 'compact cs', style)} data-tip="${cardTip(u, m, x)}"><div class="cs-top">${logo(u, x)}<div class="cs-vals">${vals}</div></div><div class="cs-art">${art}</div></div>`
  }
  const v = box.h > box.w * 1.25 && box.w < 170, c = { w: box.w - (v ? 16 : 24), h: box.h - (v ? 20 : 12) }
  // 그림이 넓게 필요한 디자인일수록 이름을 늦게 보인다.
  const nameShown = !v && c.w >= ({ numeral: 240, rich: 250, rings: 300, battery: 340, bars: 380, timeline: 380 } as Record<DesignId, number>)[design]
  const tag = nameShown ? '' : accountTag(u.name)
  const idW = v ? 0 : 18 + (nameShown ? Math.min(120, u.name.length * 7 + 7) : 0) + (tag ? [...tag].length * 7 + 11 : 0) + 12
  return `<div ${cardAttrs(u, sev, `compact ${v ? 'cv' : ''} ${!v && !nameShown ? 'center' : ''}`, style)} data-tip="${cardTip(u, m, x)}"><div class="c-id">${logo(u, x, !nameShown)}${nameShown ? `<span class="svc">${esc(u.name)}</span>` : ''}</div><div class="c-main">${COMPACT[design](m, x, { w: c.w - idW, h: c.h }, v)}</div></div>`
}

/** 카드 하나. box는 격자 칸 크기(px). */
export function renderCard(u: AccountUsage, design: DesignId, x: ViewContext, box: { w: number; h: number }, style = '') {
  if (x.per) x = { ...x, ...x.per(u.id), per: undefined }
  const m = serviceModel(u)
  // 경고 배경: 남은 양에 따라 노랑→빨강으로 은은하게(카드 테두리는 칠하지 않는다)
  if (x.heatOn && m.available) {
    const heat = heatOf(lowestLeft(m), x.warn, x.crit, x.showPace && windowsOf(m).some(paceWarning))
    if (heat > 0) style = `--heat:${heat.toFixed(3)};${style}`
  }
  if (!m.available || !windowsOf(m).length) return offlineCard(u, x, box, style)
  if (formOf(design, box.w, box.h) === 'compact') return compactCard(u, m, design, x, box, style)
  const sev = severity(m, x.warn, x.crit, x.showPace), lo = Math.min(...windowsOf(m).map(w => w.left))
  const { bw, bh } = cardBody(box.w, box.h), narrow = box.w < 210
  const flag = !sev ? '' : `<span class="flag" data-tip="${lo <= x.warn ? `가장 빠듯한 한도의 여유가 ${lo}%예요` : '이 속도면 리셋 전에 소진될 수 있어요'}"><i></i>${narrow ? (lo <= x.warn ? lo + '%' : '!') : lo <= x.warn ? `여유 ${lo}%` : '속도 주의'}</span>`
  const tier = design === 'rich' ? richTier(bw, bh) : ''
  const multi = windowsOf(m).length > 1
  const showSrc = multi && box.w >= 150 && (['numeral', 'rings', 'battery'].includes(design) || (design === 'rich' && ['mw', 'l', 'lw', 'tall', 'ml'].includes(tier)))
  const o = design === 'rich' ? 'h' : fitDesign(design, bw, bh).o
  const foot = x.showReset && ['numeral', 'bars', 'battery', 'rings'].includes(design) && bh > 110
    ? `<div class="foot">${windowsOf(m).filter(w => w.resetMs !== null).map((w, i) => i === 0 || box.w > 260 ? `<span>${box.w >= 200 ? `${w.label} 리셋 ${fmtDuration(w.resetMs)}` : `${w.short} ${fmtDurationShort(w.resetMs)}`}</span>` : '').join('')}</div>` : ''
  // 이름이 가장 중요하다. 좁으면 줄임표로 줄여서라도 남기고, 정말 좁을 때만 뺀다.
  const nameShown = box.w > (flag ? (showSrc ? 190 : 160) : 120)
  const body = design === 'rich' ? rich(m, x, { w: bw, h: bh }) : FULL[design](m, x, { w: bw, h: Math.max(20, bh - (foot ? 18 : 0)), o })
  return `<div ${cardAttrs(u, sev, '', style)} data-tip="${cardTip(u, m, x)}">
    <div class="card-head">${logo(u, x, !nameShown)}${nameShown ? `<span class="svc">${esc(u.name)}</span>` : ''}${u.plan && !isOutOfDate(u) && box.w >= (flag ? 330 : 260) ? `<span class="plan-pill">${esc(u.plan)}</span>` : ''}${u.pending && box.w >= 240 ? `<span class="stale-chip pending" data-tip="${esc(PENDING_TIP)}">확인 중</span>` : isOutOfDate(u) && box.w >= 240 ? `<span class="stale-chip" data-tip="${esc(staleTip(u, Date.now(), u.status === 'stale'))}">갱신 안 됨</span>` : ''}${flag}${showSrc ? `<button class="src" data-src="${esc(u.id)}" data-tip="큰 숫자 기준 바꾸기" aria-label="큰 숫자 기준" aria-haspopup="menu">${({ weekly: '주간', '5h': u.primaryKind === 'monthly' ? '월간' : '5시간', tight: '빠듯한 쪽' })[x.source(u.id)]}${chev}</button>` : ''}</div>
    <div class="body">${body}</div>${foot}</div>`
}
