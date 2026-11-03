import type { AppState, UpdateState } from '../../common/types.js'
import { applyAppearance, escapeText, icon, hourLabel, updateHourSelect } from './dashboard.js'
import { updateMarkup } from '../dom-update.js'
import { getLang, locale, tr, trText } from '../../common/i18n.js'
import changelog from '../../../CHANGELOG.md?raw'
import changelogEn from '../../../CHANGELOG.en.md?raw'

/**
 * '정보·업데이트' 창. 지금 버전, 업데이트 상태(확인 중·받는 중·설치 준비)와 새 버전에서 바뀌는 점, 바로 업데이트,
 * 자동 업데이트 설정, 지금 버전의 변경 내역, 링크. 변경 내역은 앱에 묶인 CHANGELOG.md(인터넷 없이도 보임).
 */
const REPO = 'https://github.com/ngnearSINE/ai-usage-widget'
const UPSTREAM = 'https://github.com/sallyHADEV/ai-usage-taskbar-widget'

/** 마크다운 '## 버전' 절들. 굵게(**)만 살리고 나머지는 글자 그대로. */
function sections(md: string): Array<{ version: string; items: string[] }> {
  const out: Array<{ version: string; items: string[] }> = []
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+)$/.exec(line)
    if (h) { out.push({ version: h[1].trim(), items: [] }); continue }
    const b = /^\s*[-*]\s+(.+)$/.exec(line)
    if (b) { if (!out.length) out.push({ version: '', items: [] }); out[out.length - 1].items.push(b[1]) }
  }
  return out
}
/** 변경 내역 절들. 영어 화면이면 CHANGELOG.en.md에서 같은 버전 절을 찾고, 없으면 한국어 절을 그대로 쓴다. */
function changelogSections() {
  const ko = sections(changelog)
  if (getLang() !== 'en') return ko
  const en = sections(changelogEn)
  return ko.map(sec => en.find(x => x.version === sec.version && x.items.length) || sec)
}
// Releases 설명: 한국어 내역 + '## English' + 영어 내역 + '## 설치 방법 …'(바뀌는 점이 아니므로 뺀다).
const INSTALL_HEAD = /^##\s+설치 방법/m // i18n-ok
const ENGLISH_HEAD = /^##\s+English[ \t]*$/m
/** 업데이트 알림의 바뀌는 점: 화면 언어에 맞는 쪽(영어가 없으면 한국어). */
function releaseNotes(notes: string) {
  const body = notes.split(INSTALL_HEAD)[0], at = body.search(ENGLISH_HEAD)
  if (at < 0) return body
  const ko = body.slice(0, at), en = body.slice(at).replace(ENGLISH_HEAD, '')
  return getLang() === 'en' && sections(en).some(x => x.items.length) ? en : ko
}
const inline = (s: string) => escapeText(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
const clock = (iso?: string) => {
  const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return ''
  const min = Math.round((Date.now() - t) / 60e3), d = new Date(t)
  const hm = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })
  return min < 1 ? tr('방금({hm})', { hm }) : min < 60 ? tr('{n}분 전({hm})', { n: min, hm }) : hm
}
const SVG = {
  ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.6L16 9.6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5"/><path d="M5 19h14"/></svg>',
  gift: '<svg viewBox="0 0 24 24"><path d="M12 3v3m0 0a3 3 0 1 0-3-3m3 3a3 3 0 1 1 3-3M4 10h16v4H4zM6 14v6h12v-6M12 10v10"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.3"/></svg>',
}

let bound = false
let showAll = false
let showAllNew = false
let checkingLocal = false // '업데이트 확인'을 누른 순간부터 결과가 올 때까지
let lastState: AppState

/** 업데이트 영역: 상태 아이콘·제목·설명, 새 버전이면 버전 변화와 바뀌는 점, 그리고 단추. */
function updatePanel(s: AppState) {
  const u: UpdateState | undefined = s.update
  if (!u || u.status === 'unsupported') {
    const text = s.dockSupported === false ? tr('AppImage로 실행할 때만 자동으로 업데이트돼요. deb으로 설치했다면 새 버전 deb을 받아 설치해 주세요.') : tr('설치판에서만 자동으로 업데이트돼요. 휴대용(zip)은 새 버전을 직접 받아 주세요.')
    return `<div class="up-state"><span class="up-icon info">${SVG.info}</span><div><b>${tr('직접 업데이트하는 버전이에요')}</b><p>${text}</p></div></div>
      <button class="secondary-button" data-link="${REPO}/releases/latest">${icon('arrow')}${tr('새 버전 받으러 가기')}</button>`
  }
  const checking = checkingLocal || u.status === 'checking'
  const newVer = (u.status === 'downloading' || u.status === 'ready') && u.version ? u.version : ''
  const at = clock(u.checkedAt)
  let head = '', action = ''
  if (checking && !newVer) {
    head = `<div class="up-state"><span class="up-icon spin">${icon('refresh')}</span><div><b>${tr('새 버전이 있는지 확인하는 중…')}</b><p>${tr('잠깐이면 돼요.')}</p></div></div>`
    action = `<button class="secondary-button" disabled><span class="spin">${icon('refresh')}</span>${tr('확인 중…')}</button>`
  } else if (u.status === 'downloading') {
    head = `<div class="up-state"><span class="up-icon accent">${SVG.down}</span><div><b>${tr('새 버전을 받는 중이에요')}</b><p>${tr('받기가 끝나면 바로 업데이트할 수 있어요.')}</p></div></div>`
    action = `<div class="up-progress"><i style="width:${u.percent ?? 0}%"></i></div><button class="primary-button wide" disabled>${tr('받는 중… {n}%', { n: u.percent ?? 0 })}</button>`
  } else if (u.status === 'ready') {
    head = `<div class="up-state"><span class="up-icon accent">${SVG.gift}</span><div><b>${tr('새 버전으로 업데이트할 수 있어요')}</b><p>${s.config.autoUpdate === false ? tr('아래 단추를 누르면 바로 업데이트해요.') : tr('그냥 두면 {at}에 자동으로 업데이트해요.', { at: hourLabel(s.config.updateHour ?? 3) })}</p></div></div>`
    action = `<button class="primary-button wide" data-install>${SVG.down}${tr('지금 업데이트')}</button><p class="up-hint">${tr('앱이 잠깐 꺼졌다가 {v}로 다시 켜져요. 설정과 기록은 그대로예요.', { v: escapeText(newVer) })}</p>`
  } else if (u.status === 'error') {
    head = `<div class="up-state"><span class="up-icon bad">${SVG.warn}</span><div><b>${tr('확인하지 못했어요')}</b><p>${escapeText(trText(u.message) || tr('잠시 뒤 다시 해 주세요.'))}${at ? ` · ${at}` : ''}</p></div></div>`
    action = `<button class="secondary-button" data-check>${icon('refresh')}${tr('다시 확인')}</button>`
  } else {
    const latest = u.status === 'latest'
    head = `<div class="up-state"><span class="up-icon ${latest ? 'good' : 'info'}">${latest ? SVG.ok : SVG.info}</span><div><b>${latest ? tr('최신 버전이에요') : tr('아직 확인 전이에요')}</b><p>${latest && at ? tr('마지막 확인: {at}', { at }) : s.config.autoUpdate === false ? tr('자동 확인이 꺼져 있어요. 아래 단추로 확인해 주세요.') : tr('6시간마다 저절로 확인해요.')}</p></div></div>`
    action = `<button class="secondary-button" data-check>${icon('refresh')}${tr('업데이트 확인')}</button>`
  }
  // 새 버전: 버전 변화와 새 버전에서 바뀌는 점
  let news = ''
  if (newVer) {
    const items = sections(releaseNotes(u.notes || '')).flatMap(x => x.items)
    const shown = showAllNew ? items : items.slice(0, 6)
    news = `<div class="up-version"><span class="v-old">${escapeText(s.version || '')}</span><span class="v-arrow">→</span><span class="v-new">${escapeText(newVer)}</span></div>
      <div class="up-news"><div class="up-news-head">${tr('{v}에서 바뀌는 점', { v: escapeText(newVer) })}</div>${items.length
        ? `<ul>${shown.map(i => `<li>${inline(i)}</li>`).join('')}</ul>${items.length > 6 ? `<button class="link-button" data-more-new>${showAllNew ? tr('접기') : tr('{n}개 더 보기', { n: items.length - 6 })}</button>` : ''}`
        : `<p class="up-hint">${tr('설명을 불러오는 중이에요.')} <button class="link-button" data-link="${REPO}/releases/tag/v${encodeURIComponent(newVer)}">${tr('GitHub에서 보기')}</button></p>`}</div>`
  }
  return head + news + action
}

export function renderAbout(container: HTMLElement, s: AppState) {
  lastState = s
  applyAppearance(s.config)
  // 확인 결과(최신·받는 중·오류)가 오면 '확인 중' 표시를 끝낸다
  if (checkingLocal && s.update && s.update.status !== 'checking' && s.update.status !== 'idle') checkingLocal = false
  const all = changelogSections(), mine = all.find(x => x.version === s.version) || all[0]
  const supported = s.update && s.update.status !== 'unsupported'
  const list = showAll ? all : mine ? [mine] : []
  updateMarkup(container, `<div class="dashboard about-root">
    <header class="s-titlebar"><span class="app-symbol" aria-hidden="true"><i></i><i></i><i></i></span><span class="app-title">${tr('AI 사용량 정보')}</span><div class="s-winbtns"><button data-win="close" class="close" title="${tr('닫기')}" aria-label="${tr('닫기')}"><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg></button></div></header>
    <main class="about-body">
      <section class="about-hero"><span class="about-logo" aria-hidden="true"><i></i><i></i><i></i></span><div><h1>${tr('AI 사용량 위젯')}</h1><p><span class="ver-pill">v${escapeText(s.version || '')}</span>${s.preview ? `<span class="ver-sub">${tr('미리보기')}</span>` : ''}</p></div></section>
      <section class="about-card up-card">${updatePanel(s)}</section>
      ${supported ? `<section class="about-card up-settings">
        <label class="up-row"><span><b>${tr('자동 업데이트')}</b><small>${tr('6시간마다 확인해 미리 받아 둬요')}</small></span><input class="switch" type="checkbox" data-auto ${s.config.autoUpdate !== false ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span></label>
        <label class="up-row ${s.config.autoUpdate === false ? 'is-disabled' : ''}"><span><b>${tr('설치 시각')}</b><small>${tr('받아 둔 새 버전을 이 시각에 설치해요')}</small></span>${updateHourSelect(s)}</label>
      </section>` : ''}
      <section class="about-notes">
        <div class="about-card-head"><b>${showAll ? tr('전체 변경 내역') : tr('지금 버전({v})에서 바뀐 점', { v: escapeText(mine?.version || '') })}</b><button class="link-button" data-notes>${showAll ? tr('지금 버전만') : tr('전체 보기')}</button></div>
        ${list.map(sec => `${showAll ? `<h3>${escapeText(sec.version)}</h3>` : ''}<ul>${sec.items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`).join('')}
      </section>
      <section class="about-links">
        ${s.guideAvailable ? `<button class="ghost-button" data-guide>${icon('book')}${tr('사용 설명서')}</button>` : ''}
        <button class="ghost-button" data-link="${REPO}">${icon('arrow')}${tr('GitHub 저장소')}</button>
        <button class="ghost-button" data-link="${UPSTREAM}">${icon('arrow')}${tr('원본 프로젝트')}</button>
      </section>
      <p class="about-foot">${tr('{repo}을 fork해 고친 버전 · MIT', { repo: 'sallyHADEV/ai-usage-taskbar-widget' })}</p>
    </main>
  </div>`)
  if (bound) return
  bound = true
  container.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button'); if (!t || t.hasAttribute('disabled')) return
    if (t.dataset.win) window.api.windowControl('close')
    else if (t.hasAttribute('data-check')) {
      // 누르자마자 '확인 중'을 보여 주고, 결과가 오면 그 상태로 바꾼다
      checkingLocal = true; renderAbout(container, lastState)
      void window.api.checkUpdate().then(next => { checkingLocal = false; renderAbout(container, next) }).catch(() => { checkingLocal = false; renderAbout(container, lastState) })
    }
    else if (t.hasAttribute('data-install')) { t.setAttribute('disabled', ''); t.textContent = tr('업데이트하는 중…'); void window.api.installUpdate() }
    else if (t.hasAttribute('data-guide')) void window.api.openGuide()
    else if (t.dataset.link) void window.api.openExternal(t.dataset.link)
    else if (t.hasAttribute('data-notes')) { showAll = !showAll; renderAbout(container, lastState) }
    else if (t.hasAttribute('data-more-new')) { showAllNew = !showAllNew; renderAbout(container, lastState) }
  })
  container.addEventListener('change', e => {
    const t = e.target as HTMLInputElement
    if (t.matches('[data-auto]')) void window.api.updateConfig({ autoUpdate: t.checked })
    if (t.matches('[data-update-hour]')) void window.api.updateConfig({ updateHour: Number(t.value) })
  })
  window.addEventListener('keydown', e => { if (e.key === 'Escape') window.api.windowControl('close') })
}
