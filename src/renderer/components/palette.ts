import type { Command } from '../commands.js'
import { GESTURES } from '../commands.js'
import { pushRecent, rankCommands } from '../../common/command-match.js'
import { tr } from '../../common/i18n.js'

/**
 * 명령 팔레트(Ctrl+K)와 단축키 도움말(?). 창 위에 떠 있는 판 하나로, 창이 다시 그려져도 사라지지 않게 body에 붙인다.
 * 키보드만으로: 입력 → ↑↓로 고르기 → Enter 실행, Esc 닫기. 최근에 쓴 명령이 앞에 온다(이 PC에만 기억).
 */
const RECENT_KEY = 'palette.recent'
const esc = (v: string) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const readRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') } catch { return [] } }
const saveRecent = (r: string[]) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(r)) } catch { /* 기억 못 해도 동작은 같다 */ } }

let overlay: HTMLElement | null = null
let restoreFocus: HTMLElement | null = null
let onClose: (() => void) | null = null

export const paletteOpen = () => !!overlay

export function closeOverlay() {
  if (!overlay) return
  overlay.classList.add('closing')
  const el = overlay
  overlay = null
  setTimeout(() => el.remove(), 120)
  window.removeEventListener('keydown', onKey, true)
  restoreFocus?.focus?.()
  onClose?.(); onClose = null
}

let keyHandler: (e: KeyboardEvent) => void = () => {}
function onKey(e: KeyboardEvent) { keyHandler(e) }

function mount(html: string, label: string) {
  closeOverlay()
  restoreFocus = document.activeElement as HTMLElement | null
  overlay = document.createElement('div')
  overlay.className = 'pal-overlay'
  overlay.innerHTML = `<div class="pal" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div>`
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) closeOverlay() })
  document.body.appendChild(overlay)
  window.addEventListener('keydown', onKey, true)
  return overlay.querySelector<HTMLElement>('.pal')!
}

const kbd = (accel?: string) => accel ? `<kbd>${esc(accel)}</kbd>` : ''

/** 명령 팔레트. commands는 열 때마다 새로 만든다(지금 상태·체크 표시가 맞도록). */
export function openPalette(commands: () => Command[]) {
  const all = commands()
  let recent = readRecent(), query = '', active = 0, shown: Command[] = []
  const pal = mount(`<div class="pal-input"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><input type="text" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="pal-list" placeholder="${esc(tr('무엇을 할까요? 서비스 이름·디자인·설정…'))}"></div>
    <ul class="pal-list" id="pal-list" role="listbox"></ul>
    <div class="pal-foot"><span>${kbd('↑↓')} ${tr('고르기')}</span><span>${kbd('Enter')} ${tr('실행')}</span><span>${kbd('Esc')} ${tr('닫기')}</span></div>`, tr('명령 찾기'))
  const input = pal.querySelector<HTMLInputElement>('input')!, listEl = pal.querySelector<HTMLElement>('.pal-list')!
  const run = (c: Command) => { saveRecent(pushRecent(recent, c.id)); closeOverlay(); c.run() }
  const draw = () => {
    shown = rankCommands(all, query, recent)
    active = Math.max(0, Math.min(active, shown.length - 1))
    listEl.innerHTML = shown.length ? shown.map((c, i) => `<li role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === active}" class="${i === active ? 'on' : ''}">
        <span class="pal-mark">${c.tone ? `<i class="dot t-${c.tone}"></i>` : c.check ? '✓' : c.on ? '•' : ''}</span>
        <span class="pal-text"><b>${esc(c.title)}</b>${c.sub ? `<small>${esc(c.sub)}</small>` : ''}</span>
        <span class="pal-meta">${kbd(c.accel)}<em>${esc(c.group)}</em></span></li>`).join('')
      : `<li class="pal-empty">${tr('맞는 명령이 없어요. 다른 낱말로 찾아 보세요.')}</li>`
    input.setAttribute('aria-activedescendant', shown.length ? `pal-${active}` : '')
    listEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }
  input.addEventListener('input', () => { query = input.value; active = 0; draw() })
  listEl.addEventListener('pointermove', e => { const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]'); if (li && Number(li.dataset.i) !== active) { active = Number(li.dataset.i); draw() } })
  listEl.addEventListener('click', e => { const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]'); if (li) run(shown[Number(li.dataset.i)]) })
  keyHandler = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeOverlay(); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); if (shown.length) { active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length; draw() } return }
    if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); if (shown[active]) run(shown[active]); return }
    // 다른 키(글자 입력)는 입력 칸이 받는다. 창의 단축키(숫자·`)로 새지 않게 막는다.
    if (e.target === input) e.stopImmediatePropagation()
  }
  draw()
  input.focus()
}

/** 단축키 도움말: 이 창의 단축키(명령 목록에서), 마우스로 하는 일, 어디서나 쓰는 단축키(설정에서 바꾼 값). */
export function openHelp(commands: () => Command[], global: Array<[string, string]>) {
  const keyed = commands().filter(c => c.accel && !/^(design|size)-/.test(c.id))
  const designs = commands().filter(c => c.id.startsWith('design-'))
  const rows = (list: Array<[string, string]>) => list.map(([k, v]) => `<li><span>${esc(v)}</span>${kbd(k)}</li>`).join('')
  const pal = mount(`<div class="pal-head"><b>${tr('단축키')}</b><button class="pal-x" data-close aria-label="${tr('닫기')}">✕</button></div>
    <div class="pal-help">
      <section><h3>${tr('이 창')}</h3><ul>${rows(keyed.map(c => [c.accel!, c.title]))}${rows([['1~5', tr('창 크기')], [`Ctrl+1~${designs.length}`, tr('디자인 바꾸기')], ['Esc', tr('집중 모드 끄기·창 닫기')]])}</ul></section>
      <section><h3>${tr('마우스')}</h3><ul>${GESTURES().map(([k, v]) => `<li><span>${esc(v)}</span><em>${esc(k)}</em></li>`).join('')}</ul></section>
      ${global.length ? `<section><h3>${tr('어디서나')}</h3><ul>${rows(global)}</ul><p>${tr('설정 → 일반 → 단축키에서 바꿀 수 있어요.')}</p></section>` : ''}
    </div>`, tr('단축키'))
  pal.classList.add('help')
  pal.querySelector<HTMLElement>('[data-close]')!.onclick = () => closeOverlay()
  keyHandler = e => { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopImmediatePropagation(); closeOverlay() } }
  pal.querySelector<HTMLElement>('[data-close]')!.focus()
}
