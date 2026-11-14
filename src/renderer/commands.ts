import type { AppState, WidgetConfig } from '../common/types.js'
import { LANG_NAMES, tr, trText } from '../common/i18n.js'
import { DESIGNS, lowestLeft, serviceModel } from '../common/usage-model.js'
import { cardStatus } from '../common/status.js'
import { visibleUsages } from '../common/widget-layout.js'
import { maskText } from '../common/privacy.js'

/**
 * 창(위젯)의 모든 명령. ☰ 메뉴·제목줄 우클릭, 명령 팔레트(Ctrl+K), 단축키 도움말(?)이 이 목록 하나를 쓴다.
 * 그래서 이름·단축키 표기·동작이 어디서나 같다.
 */
export interface Command {
  id: string
  title: string
  /** 분류(팔레트에서 오른쪽에 흐리게, 검색에도 쓴다) */
  group: string
  /** 검색용 다른 이름 */
  keywords?: string
  accel?: string
  /** 팔레트에서 제목 아래 한 줄(서비스 상태 등) */
  sub?: string
  /** 상태가 있는 서비스 명령: 점 색 */
  tone?: 'ok' | 'warn' | 'danger' | 'muted'
  check?: boolean
  on?: boolean
  run: () => void
}

export interface CommandDeps {
  state: AppState
  update: (patch: Partial<WidgetConfig>) => void
  notify: (message: string) => void
  openTool: (kind: 'cli' | 'app', id: string) => void
  toggleLockCards: () => void
  toggleHideHeader: () => void
  openPalette: () => void
  openHelp: () => void
}

const SIZE_NAMES = () => [tr('아주 작게'), tr('작게'), tr('보통'), tr('크게'), tr('아주 크게')]
const SETTINGS_TABS = () => [['design', tr('디자인')], ['display', tr('표시')], ['services', tr('서비스')], ['alerts', tr('알림')], ['general', tr('일반')]] as const

export function buildCommands(d: CommandDeps): Command[] {
  const c = d.state.config, cur = c.design || 'rich', pinned = c.alwaysOnTop !== false
  const G = { design: tr('디자인'), view: tr('보기'), window: tr('창'), service: tr('서비스'), open: tr('열기'), app: tr('앱') }
  const list: Command[] = [
    ...DESIGNS.map(([key, label, desc], i) => ({ id: `design-${key}`, title: trText(label), group: G.design, keywords: `${trText(desc)} design`, accel: `Ctrl+${i + 1}`, on: cur === key, run: () => d.update({ design: key }) })),
    { id: 'refresh', title: tr('사용량 새로고침'), group: G.view, keywords: 'refresh reload', run: () => { void window.api.refreshQuota().catch(() => d.notify(tr('새로고침에 실패했어요.'))) } },
    { id: 'group-accounts', title: tr('여러 계정 묶기와 추천'), group: G.view, keywords: 'group recommend', check: c.groupAccounts !== false, run: () => { const on = c.groupAccounts === false; d.update({ groupAccounts: on }); d.notify(on ? tr('같은 서비스 계정을 묶고 지금 쓰기 좋은 계정을 표시해요.') : tr('계정을 묶지 않아요.')) } },
    { id: 'mask-email', title: tr('이메일 가리기'), group: G.view, keywords: 'privacy mask email screen share', check: c.maskEmail === true, run: () => { const on = c.maskEmail !== true; d.update({ maskEmail: on }); d.notify(on ? tr('이메일과 계정 표식을 가렸어요.') : tr('이메일을 다시 보여 줘요.')) } },
    { id: 'pin', title: tr('항상 위'), group: G.window, keywords: 'always on top pin', check: pinned, run: () => { d.update({ alwaysOnTop: !pinned }); d.notify(!pinned ? tr('항상 위에 표시해요.') : tr('다른 창 뒤로 갈 수 있어요.')) } },
    { id: 'lock-cards', title: tr('카드 위치 고정'), group: G.window, accel: 'Shift+`', check: !!c.lockCards, run: d.toggleLockCards },
    { id: 'hide-header', title: tr('제목줄 항상 숨기기'), group: G.window, accel: '`', check: !!c.hideHeader, run: d.toggleHideHeader },
    ...SIZE_NAMES().map((name, i) => ({ id: `size-${i + 1}`, title: tr('창 크기: {name}', { name }), group: G.window, keywords: 'size', accel: String(i + 1), run: () => { void window.api.sizePreset(i + 1).then(label => { if (label) d.notify(tr('크기: {name}', { name: trText(label) })) }) } })),
    { id: 'palette', title: tr('명령 찾기'), group: G.app, keywords: 'command palette search', accel: 'Ctrl+K', run: d.openPalette },
    { id: 'help', title: tr('단축키 보기'), group: G.app, keywords: 'shortcuts keys help', accel: '?', run: d.openHelp },
    { id: 'settings', title: tr('설정'), group: G.open, keywords: 'settings preferences', run: () => { void window.api.openSettings('last') } },
    ...SETTINGS_TABS().map(([tab, name]) => ({ id: `settings-${tab}`, title: tr('설정: {name}', { name }), group: G.open, keywords: 'settings', run: () => { void window.api.openSettings(tab) } })),
    { id: 'stats', title: tr('사용량 통계'), group: G.open, keywords: 'stats history cost', run: () => { void window.api.openStats() } },
    { id: 'about', title: tr('정보·업데이트'), group: G.open, keywords: 'about update version', run: () => { void window.api.openAbout?.() } },
    { id: 'lang-system', title: tr('언어: 시스템 따라'), group: G.app, keywords: 'language', on: (c.language ?? 'system') === 'system', run: () => d.update({ language: 'system' }) },
    { id: 'lang-ko', title: `${tr('언어')}: ${LANG_NAMES.ko}`, group: G.app, keywords: 'language korean', on: c.language === 'ko', run: () => d.update({ language: 'ko' }) },
    { id: 'lang-en', title: `${tr('언어')}: ${LANG_NAMES.en}`, group: G.app, keywords: 'language english', on: c.language === 'en', run: () => d.update({ language: 'en' }) },
    { id: 'hide', title: tr('트레이로 숨기기'), group: G.app, keywords: 'hide tray', run: () => { void window.api.hideWidget() } },
    { id: 'quit', title: tr('종료'), group: G.app, keywords: 'quit exit', run: () => { void window.api.quitApp() } },
  ]
  // 서비스마다: 집중해서 보기, CLI 열기, 앱 열기(상태를 함께 보여 준다)
  const warn = c.warnPercent ?? 20, crit = Math.min(warn, c.critPercent ?? 10), mask = c.maskEmail === true
  for (const u of visibleUsages(d.state.usages, d.state.accounts, c)) {
    const m = serviceModel(u), st = cardStatus(u, m, warn, crit, c.showPace !== false), name = maskText(u.name, mask)
    const sub = m.available ? `${st.label} · ${tr('가장 빠듯한 한도 {n}%', { n: lowestLeft(m) })}` : st.label
    list.push(
      { id: `focus-${u.id}`, title: tr('{name} 집중해서 보기', { name }), group: G.service, keywords: `${u.provider} focus`, sub, tone: st.tone, on: d.state.focus === u.id, run: () => { void window.api.setFocus(u.id) } },
      { id: `cli-${u.id}`, title: tr('{name} CLI 열기', { name }), group: G.service, keywords: `${u.provider} terminal cli`, run: () => d.openTool('cli', u.id) },
      { id: `app-${u.id}`, title: tr('{name} 앱 열기', { name }), group: G.service, keywords: `${u.provider} app desktop`, run: () => d.openTool('app', u.id) })
  }
  return list
}

/** 마우스로 하는 일(도움말용). */
export const GESTURES = () => [
  [tr('카드 두 번 누르기'), tr('그 서비스만 크게 보기(집중), 다시 누르면 돌아오기')],
  [tr('Ctrl + 카드 두 번 누르기'), tr('그 계정의 CLI 열기')],
  [tr('Shift + 카드 두 번 누르기'), tr('그 서비스의 앱 열기')],
  [tr('카드 끌기'), tr('순서 바꾸기')],
  [tr('Ctrl + 창 모서리 끌기'), tr('스케일(창 전체 확대·축소) 바꾸기')],
  [tr('카드 우클릭'), tr('그 서비스의 메뉴')],
  [tr('제목줄 끌기'), tr('창 옮기기(작업 표시줄로 끌면 붙이기)')],
] as const
