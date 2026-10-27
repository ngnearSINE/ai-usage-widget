import type { AppState } from '../../common/types.js'
import { applyAppearance, escapeText, icon, hourLabel, updateHourSelect } from './dashboard.js'
import { updateMarkup } from '../dom-update.js'
import changelog from '../../../CHANGELOG.md?raw'

/**
 * '정보·업데이트' 창. 버전, 업데이트 상태와 조작, 이번 버전 변경 내역, 링크.
 * 변경 내역은 앱에 함께 묶인 CHANGELOG.md에서 읽는다(인터넷 없이도 보인다).
 */
const REPO = 'https://github.com/ngnearSINE/ai-usage-widget'
const UPSTREAM = 'https://github.com/sallyHADEV/ai-usage-taskbar-widget'

/** CHANGELOG.md의 '## 버전' 절들. 굵게(**)만 살리고 나머지는 글자 그대로. */
function sections(): Array<{ version: string; items: string[] }> {
  const out: Array<{ version: string; items: string[] }> = []
  for (const line of changelog.split(/\r?\n/)) {
    const h = /^##\s+(.+)$/.exec(line)
    if (h) { out.push({ version: h[1].trim(), items: [] }); continue }
    const b = /^-\s+(.+)$/.exec(line)
    if (b && out.length) out[out.length - 1].items.push(b[1])
  }
  return out
}
const inline = (s: string) => escapeText(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

let bound = false
let showAll = false
export function renderAbout(container: HTMLElement, s: AppState) {
  applyAppearance(s.config)
  const u = s.update, all = sections(), mine = all.find(x => x.version === s.version) || all[0]
  const statusText = !u || u.status === 'unsupported' ? (s.dockSupported === false ? '자동 업데이트는 AppImage로 실행할 때만 돼요. deb으로 설치했다면 새 버전 deb을 내려받아 설치해 주세요.' : '자동 업데이트는 설치판에서만 돼요. 휴대용(zip)은 새 버전을 직접 내려받아 주세요.')
    : u.status === 'checking' ? '새 버전을 확인하고 있어요…'
    : u.status === 'downloading' ? `새 버전 ${escapeText(u.version || '')}을 받고 있어요`
    : u.status === 'ready' ? `새 버전 ${escapeText(u.version || '')}이 준비됐어요. ${s.config.autoUpdate === false ? '아래 단추나 위젯 제목줄의 ‘업데이트’를 누르면 설치돼요.' : `${hourLabel(s.config.updateHour ?? 3)}나 앱을 끌 때 설치돼요. 지금 바로 설치할 수도 있어요.`}`
    : u.status === 'latest' ? '최신 버전을 쓰고 있어요.'
    : u.status === 'error' ? escapeText(u.message || '업데이트를 확인하지 못했어요.')
    : s.config.autoUpdate === false ? '자동 업데이트가 꺼져 있어요. ‘업데이트 확인’으로 직접 받을 수 있어요.' : `6시간마다 새 버전을 확인해 받아 두고, ${hourLabel(s.config.updateHour ?? 3)}에 설치해요.`
  const tone = u?.status === 'ready' ? 'good' : u?.status === 'error' ? 'bad' : ''
  const supported = u && u.status !== 'unsupported'
  const list = showAll ? all : mine ? [mine] : []
  updateMarkup(container, `<div class="dashboard about-root">
    <header class="s-titlebar"><span class="app-symbol" aria-hidden="true"><i></i><i></i><i></i></span><span class="app-title">AI 사용량 정보</span><div class="s-winbtns"><button data-win="close" class="close" title="닫기" aria-label="닫기"><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg></button></div></header>
    <main class="about-body">
      <section class="about-hero"><span class="about-logo" aria-hidden="true"><i></i><i></i><i></i></span><div><h1>AI 사용량 위젯</h1><p>버전 <b>${escapeText(s.version || '')}</b>${s.preview ? ' · 미리보기' : ''}</p></div></section>
      <section class="about-card">
        <div class="about-card-head"><b>업데이트</b>${supported ? `<label class="setting-row inline"><span>자동 업데이트</span><input class="switch" type="checkbox" data-auto ${s.config.autoUpdate !== false ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span></label>` : ''}</div>
        <p class="about-status ${tone}">${statusText}</p>
        ${supported ? `<label class="field inline-field"><span>자동 설치 시각</span>${updateHourSelect(s)}</label>` : ''}
        ${u?.status === 'downloading' ? `<div class="about-progress"><i style="width:${u.percent ?? 0}%"></i></div>` : ''}
        ${supported ? (u!.status === 'ready' ? `<button class="primary-button wide" data-install>${icon('refresh')}다시 시작해 ${escapeText(u!.version || '')} 설치</button>`
          : `<button class="secondary-button" data-check ${['checking', 'downloading'].includes(u!.status) ? 'disabled' : ''}>${icon('refresh')}지금 확인</button>`) : `<button class="secondary-button" data-link="${REPO}/releases/latest">${icon('arrow')}Releases에서 내려받기</button>`}
      </section>
      <section class="about-notes">
        <div class="about-card-head"><b>${showAll ? '변경 내역' : `이번 버전(${escapeText(mine?.version || '')})에서 바뀐 것`}</b><button class="link-button" data-notes>${showAll ? '이번 버전만' : '전체 보기'}</button></div>
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
    const t = (e.target as HTMLElement).closest<HTMLElement>('button'); if (!t) return
    if (t.dataset.win) window.api.windowControl('close')
    else if (t.hasAttribute('data-check')) void window.api.checkUpdate()
    else if (t.hasAttribute('data-install')) void window.api.installUpdate()
    else if (t.hasAttribute('data-guide')) void window.api.openGuide()
    else if (t.dataset.link) void window.api.openExternal(t.dataset.link)
    else if (t.hasAttribute('data-notes')) { showAll = !showAll; void window.api.getState().then(next => renderAbout(container, next)) }
  })
  container.addEventListener('change', e => {
    const t = e.target as HTMLInputElement
    if (t.matches('[data-auto]')) void window.api.updateConfig({ autoUpdate: t.checked })
    if (t.matches('[data-update-hour]')) void window.api.updateConfig({ updateHour: Number(t.value) })
  })
  window.addEventListener('keydown', e => { if (e.key === 'Escape') window.api.windowControl('close') })
}
