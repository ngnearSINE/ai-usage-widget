import type { AppState, UpdateState } from '../../common/types.js'
import { applyAppearance, escapeText, icon, hourLabel, updateHourSelect } from './dashboard.js'
import { updateMarkup } from '../dom-update.js'
import changelog from '../../../CHANGELOG.md?raw'

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
const inline = (s: string) => escapeText(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
const clock = (iso?: string) => {
  const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return ''
  const min = Math.round((Date.now() - t) / 60e3), d = new Date(t)
  const hm = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
  return min < 1 ? `방금(${hm})` : min < 60 ? `${min}분 전(${hm})` : hm
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
    const text = s.dockSupported === false ? 'AppImage로 실행할 때만 자동으로 업데이트돼요. deb으로 설치했다면 새 버전 deb을 받아 설치해 주세요.' : '설치판에서만 자동으로 업데이트돼요. 휴대용(zip)은 새 버전을 직접 받아 주세요.'
    return `<div class="up-state"><span class="up-icon info">${SVG.info}</span><div><b>직접 업데이트하는 버전이에요</b><p>${text}</p></div></div>
      <button class="secondary-button" data-link="${REPO}/releases/latest">${icon('arrow')}새 버전 받으러 가기</button>`
  }
  const checking = checkingLocal || u.status === 'checking'
  const newVer = (u.status === 'downloading' || u.status === 'ready') && u.version ? u.version : ''
  const at = clock(u.checkedAt)
  let head = '', action = ''
  if (checking && !newVer) {
    head = `<div class="up-state"><span class="up-icon spin">${icon('refresh')}</span><div><b>새 버전이 있는지 확인하는 중…</b><p>잠깐이면 돼요.</p></div></div>`
    action = `<button class="secondary-button" disabled><span class="spin">${icon('refresh')}</span>확인 중…</button>`
  } else if (u.status === 'downloading') {
    head = `<div class="up-state"><span class="up-icon accent">${SVG.down}</span><div><b>새 버전을 받는 중이에요</b><p>받기가 끝나면 바로 업데이트할 수 있어요.</p></div></div>`
    action = `<div class="up-progress"><i style="width:${u.percent ?? 0}%"></i></div><button class="primary-button wide" disabled>받는 중… ${u.percent ?? 0}%</button>`
  } else if (u.status === 'ready') {
    head = `<div class="up-state"><span class="up-icon accent">${SVG.gift}</span><div><b>새 버전으로 업데이트할 수 있어요</b><p>${s.config.autoUpdate === false ? '아래 단추를 누르면 바로 업데이트해요.' : `그냥 두면 ${hourLabel(s.config.updateHour ?? 3)}에 자동으로 업데이트해요.`}</p></div></div>`
    action = `<button class="primary-button wide" data-install>${SVG.down}지금 업데이트</button><p class="up-hint">앱이 잠깐 꺼졌다가 ${escapeText(newVer)}로 다시 켜져요. 설정과 기록은 그대로예요.</p>`
  } else if (u.status === 'error') {
    head = `<div class="up-state"><span class="up-icon bad">${SVG.warn}</span><div><b>확인하지 못했어요</b><p>${escapeText(u.message || '잠시 뒤 다시 해 주세요.')}${at ? ` · ${at}` : ''}</p></div></div>`
    action = `<button class="secondary-button" data-check>${icon('refresh')}다시 확인</button>`
  } else {
    const latest = u.status === 'latest'
    head = `<div class="up-state"><span class="up-icon ${latest ? 'good' : 'info'}">${latest ? SVG.ok : SVG.info}</span><div><b>${latest ? '최신 버전이에요' : '아직 확인 전이에요'}</b><p>${latest && at ? `마지막 확인: ${at}` : s.config.autoUpdate === false ? '자동 확인이 꺼져 있어요. 아래 단추로 확인해 주세요.' : '6시간마다 저절로 확인해요.'}</p></div></div>`
    action = `<button class="secondary-button" data-check>${icon('refresh')}업데이트 확인</button>`
  }
  // 새 버전: 버전 변화와 새 버전에서 바뀌는 점
  let news = ''
  if (newVer) {
    const items = sections(u.notes || '').flatMap(x => x.items)
    const shown = showAllNew ? items : items.slice(0, 6)
    news = `<div class="up-version"><span class="v-old">${escapeText(s.version || '')}</span><span class="v-arrow">→</span><span class="v-new">${escapeText(newVer)}</span></div>
      <div class="up-news"><div class="up-news-head">${escapeText(newVer)}에서 바뀌는 점</div>${items.length
        ? `<ul>${shown.map(i => `<li>${inline(i)}</li>`).join('')}</ul>${items.length > 6 ? `<button class="link-button" data-more-new>${showAllNew ? '접기' : `${items.length - 6}개 더 보기`}</button>` : ''}`
        : `<p class="up-hint">설명을 불러오는 중이에요. <button class="link-button" data-link="${REPO}/releases/tag/v${encodeURIComponent(newVer)}">GitHub에서 보기</button></p>`}</div>`
  }
  return head + news + action
}

export function renderAbout(container: HTMLElement, s: AppState) {
  lastState = s
  applyAppearance(s.config)
  // 확인 결과(최신·받는 중·오류)가 오면 '확인 중' 표시를 끝낸다
  if (checkingLocal && s.update && s.update.status !== 'checking' && s.update.status !== 'idle') checkingLocal = false
  const all = sections(changelog), mine = all.find(x => x.version === s.version) || all[0]
  const supported = s.update && s.update.status !== 'unsupported'
  const list = showAll ? all : mine ? [mine] : []
  updateMarkup(container, `<div class="dashboard about-root">
    <header class="s-titlebar"><span class="app-symbol" aria-hidden="true"><i></i><i></i><i></i></span><span class="app-title">AI 사용량 정보</span><div class="s-winbtns"><button data-win="close" class="close" title="닫기" aria-label="닫기"><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg></button></div></header>
    <main class="about-body">
      <section class="about-hero"><span class="about-logo" aria-hidden="true"><i></i><i></i><i></i></span><div><h1>AI 사용량 위젯</h1><p><span class="ver-pill">v${escapeText(s.version || '')}</span>${s.preview ? '<span class="ver-sub">미리보기</span>' : ''}</p></div></section>
      <section class="about-card up-card">${updatePanel(s)}</section>
      ${supported ? `<section class="about-card up-settings">
        <label class="up-row"><span><b>자동 업데이트</b><small>6시간마다 확인해 미리 받아 둬요</small></span><input class="switch" type="checkbox" data-auto ${s.config.autoUpdate !== false ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span></label>
        <label class="up-row ${s.config.autoUpdate === false ? 'is-disabled' : ''}"><span><b>설치 시각</b><small>받아 둔 새 버전을 이 시각에 설치해요</small></span>${updateHourSelect(s)}</label>
      </section>` : ''}
      <section class="about-notes">
        <div class="about-card-head"><b>${showAll ? '전체 변경 내역' : `지금 버전(${escapeText(mine?.version || '')})에서 바뀐 점`}</b><button class="link-button" data-notes>${showAll ? '지금 버전만' : '전체 보기'}</button></div>
        ${list.map(sec => `${showAll ? `<h3>${escapeText(sec.version)}</h3>` : ''}<ul>${sec.items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`).join('')}
      </section>
      <section class="about-links">
        ${s.guideAvailable ? `<button class="ghost-button" data-guide>${icon('book')}사용 설명서</button>` : ''}
        <button class="ghost-button" data-link="${REPO}">${icon('arrow')}GitHub 저장소</button>
        <button class="ghost-button" data-link="${UPSTREAM}">${icon('arrow')}원본 프로젝트</button>
      </section>
      <p class="about-foot">sallyHADEV/ai-usage-taskbar-widget을 fork해 고친 버전 · MIT</p>
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
    else if (t.hasAttribute('data-install')) { t.setAttribute('disabled', ''); t.textContent = '업데이트하는 중…'; void window.api.installUpdate() }
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
