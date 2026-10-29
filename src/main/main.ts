import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, screen, shell, Tray } from 'electron'
import os from 'node:os'
import { IPC_CHANNELS } from '../common/ipc-events.js'
import type { AccountConfig, AppState, WidgetConfig, MenuItemSpec } from '../common/types.js'
import { AccountStore } from '../services/account-store.js'
import { QuotaManager } from '../services/quota-manager.js'
import { calculatePopupPosition, calculateWidgetPosition, getTaskbarInfo } from './taskbar-position.js'
import { LocalAppDetector } from '../services/local-app-detector.js'
import { TaskbarDocker } from './taskbar-docker.js'
import { CodexAppServerClient } from '../services/codex-app-server-client.js'
import { detectLang, setLang, t } from '../common/i18n.js'
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, fitWindow, isDockTarget, minWindowHeight, snapToEdges, visibleUsages } from '../common/widget-layout.js'
import { sanitizeConfigPatch } from '../common/config-schema.js'
import { ownColor } from '../common/bar-color.js'
import { DISPLAY_KEYS, displayOf, setDisplay } from '../common/display-options.js'
import { Updater } from './updater.js'
import { cliConfigDir, setCliRefreshEnabled } from '../services/claude-cli-refresh.js'
import { CostScanner, type CostSource } from '../services/cost-scanner.js'
import { ModelPrices } from '../services/model-prices.js'
import type { CostReport } from '../common/cost.js'
import { findApp, findCli, openApp, openCli, warmLaunchers } from './service-launch.js'
import { previewSpread, previewUsages } from '../common/preview-data.js'
import { roundedWindowShape } from '../common/window-shape.js'
import { UsageNotifier } from './notifier.js'
import { UsageHistory } from './history-store.js'
import { previewHistory } from '../common/history.js'
import { previewDaily } from '../common/stats.js'
import { DESIGNS, firstWindowLabel } from '../common/usage-model.js'
import { SurfaceWindow, surfaceKind } from './surface-window.js'
import { WebServer, DEFAULT_WEB_PORT, hashPassword } from './web-server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

setLang(detectLang(app.getLocale()))

function getPreloadPath(): string {
  const cjsPath = path.join(__dirname, 'preload.cjs')
  if (fs.existsSync(cjsPath)) return cjsPath
  return path.join(__dirname, 'preload.js')
}

// 일관된 userData 경로 유지 (개발/프로덕션 동일 설정 공유)
app.name = 'ai-usage-taskbar-widget'
const isPreview = process.argv.includes('--preview')
setCliRefreshEnabled(!isPreview)
const acrylicSupported = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621
/** 작업 표시줄 도킹·상세 팝업은 Windows 작업 표시줄 전용. Linux는 창(위젯) 모드만. */
const dockSupported = process.platform === 'win32'
// Ubuntu 24.04 등은 비특권 사용자 이름공간을 막아 AppImage의 Chromium 샌드박스가 뜨지 못한다(deb은 chrome-sandbox에 setuid가 붙어 괜찮다).
if (process.platform === 'linux' && process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox')
if (isPreview) {
  app.name = 'ai-usage-design-preview'
  app.setPath('userData', path.join(app.getPath('temp'), 'ai-usage-design-preview'))
}
// Windows 알림에 쓰는 앱 ID. 시작 메뉴 바로가기가 없는 로컬 빌드에서는 이 ID가 알림 머리에 그대로 보이므로 읽을 수 있는 이름으로 둔다.
if (process.platform === 'win32') app.setAppUserModelId(isPreview ? 'AI 사용량 (미리보기)' : 'AI 사용량')
let notifier: UsageNotifier | null = null
let updater: Updater | null = null
/** 집중 모드: 이 계정 하나만 보인다. 앱을 다시 켜면 풀린다(저장하지 않음). */
let focusId: string | null = null
function setFocus(id: string | null) {
  const next = id && accountStore.getAccounts().some(a => a.id === id) ? (focusId === id ? null : id) : null
  if (next === focusId) return
  focusId = next
  // 앱을 다시 켜도 집중 모드가 이어지게 저장한다.
  accountStore.saveConfig({ ...accountStore.getConfig(), focusId: next ?? undefined })
  broadcastState()
  if (accountStore.getConfig().placementMode === 'docked') void updateWidgetBounds()
  else if (!next) growToFitCards()
}

/** 집중 모드를 풀었을 때 창이 카드 n장의 최소 높이보다 낮으면 그 높이까지 늘린다(왼쪽 위는 그대로, 화면 안으로). */
function growToFitCards() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  const st = getAppState(), cards = Math.max(1, visibleUsages(st.usages, st.accounts, st.config).length)
  const gap = Math.max(4, Math.min(16, st.config.cardGap ?? 6)), b = widgetWindow.getBounds()
  const minH = Math.round(minWindowHeight(b.width / uiZoom(), cards, gap, !!accountStore.getConfig().hideHeader) * uiZoom())
  if (b.height >= minH) return
  const area = screen.getDisplayMatching(b).workArea
  const next = fitWindow({ ...b, height: Math.min(minH, area.height) }, area)
  widgetWindow.setBounds(next)
  accountStore.saveConfig({ ...accountStore.getConfig(), windowBounds: next })
  rememberLayout()
}
let history: UsageHistory | null = null
let costScanner: CostScanner | null = null
let modelPrices: ModelPrices | null = null

/** 비용 환산에 읽을 기록 폴더: 기본 로그인 폴더와 '다른 로그인 폴더' 계정의 폴더. */
function costRoots(): Array<{ source: CostSource; dir: string }> {
  const accs = accountStore.getAccounts()
  const claude = [cliConfigDir(), ...accs.filter(a => a.provider === 'claude' && a.homeDir).map(a => a.homeDir!)]
  const codex = [process.env.CODEX_HOME || path.join(app.getPath('home'), '.codex'), ...accs.filter(a => a.provider === 'codex' && a.homeDir).map(a => a.homeDir!)]
  const uniq = (xs: string[]) => [...new Set(xs.map(x => path.resolve(x)))]
  return [...uniq(claude).map(d => ({ source: 'claude' as const, dir: path.join(d, 'projects') })),
    ...uniq(codex).flatMap(d => ['sessions', 'archived_sessions'].map(s => ({ source: 'codex' as const, dir: path.join(d, s) })))]
}

function costReport(): CostReport {
  return { ...costScanner!.progress, prices: modelPrices!.table, pricesAt: modelPrices!.updatedAt, daily: costScanner!.totals() }
}
let web: WebServer | null = null
let shortcutErrors: string[] = []

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
  process.exit(0)
}
// 이미 실행 중일 때 시작 메뉴 등으로 다시 실행하면 숨겨 둔 위젯을 보여 준다(아무 반응이 없으면 실행이 안 된 줄 안다).
app.on('second-instance', () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  widgetManuallyHidden = false
  widgetHiddenForFullscreen = false
  if (!widgetWindow.isVisible()) { widgetWindow.show(); void updateWidgetBounds() }
  updateTrayMenu()
})
const appPageUrl = () => pathToFileURL(path.join(__dirname, '../dist/index.html')).href
// 앱 화면은 모두 로컬 파일이다. 링크나 스크립트로 다른 주소로 이동하거나 새 창을 여는 것을 막는다(외부 페이지는 openExternal로만).
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    const dev = process.env.VITE_DEV_SERVER_URL
    if (!(url.split(/[?#]/)[0] === appPageUrl() || (dev && url.startsWith(dev)))) event.preventDefault()
  })
})

// 백그라운드 스로틀링 해제 (작업표시줄 상시 모니터링)
app.commandLine.appendSwitch('disable-renderer-backgrounding')

let widgetWindow: SurfaceWindow | null = null
let popupWindow: SurfaceWindow | null = null
let settingsWindow: SurfaceWindow | null = null
let tray: Tray | null = null
let accountStore: AccountStore
let quotaManager: QuotaManager

let currentWidgetWidth = 520
let currentWidgetHeight = 36
const POPUP_WIDTH = 380
const POPUP_HEIGHT = 440

let isPopupLocked = false // 클릭으로 열었거나 팝업 조작 중일 때 자동 닫힘 방지
let widgetManuallyHidden = false // 트레이 메뉴로 사용자가 직접 숨긴 경우 (전체화면 감지로 되살리지 않음)
let widgetHiddenForFullscreen = false
let popupHideTimer: NodeJS.Timeout | null = null
let popupRevealTimer: NodeJS.Timeout | null = null
let lastDockedWidgetClickAt = 0
const DOUBLE_CLICK_WINDOW_MS = 400
let dockClickTimer: ReturnType<typeof setTimeout> | undefined

function guidePath(): string | null {
  return [path.join(path.dirname(app.getPath('exe')), '사용 설명서.pdf'), path.join(app.getAppPath(), 'docs/user-guide.pdf')].find(p => fs.existsSync(p)) || null
}
let guideKnown: boolean | undefined

function getAppState(): AppState {
  const accounts = accountStore.getAccounts()
  const raw = isPreview ? previewUsages(Date.now(), previewSpread()).filter(u => accounts.some(a => a.id === u.id && a.enabled)) : quotaManager.getUsages()
  // 모델 전용 한도(Fable 등)를 숨긴 계정은 그 값을 빼고, 설정 화면이 스위치를 보이도록 이름만 남긴다.
  const usages = raw.map(u => {
    const acc = accounts.find(a => a.id === u.id), bar = ownColor(acc?.barColor)
    const v = acc?.showScoped === false && u.scopedQuotas?.length ? { ...u, scopedQuotas: undefined, scopedHidden: u.scopedQuotas.map(s => s.label) } : u
    return bar ? { ...v, barColor: bar } : v
  })
  return {
    preview: isPreview,
    acrylicSupported,
    dockSupported,
    launchers,
    config: (({ webPasswordHash: _h, ...c }) => c)(accountStore.getConfig()),
    accounts,
    usages,
    isRefreshing: !isPreview && quotaManager.refreshing,
    lastRefreshedAt: usages.map(u => u.updatedAt).sort().at(-1) || '',
    history: history?.recent(),
    shortcutErrors,
    version: app.getVersion(),
    guideAvailable: guideKnown ??= !!guidePath(),
    update: updater?.state,
    focus: focusId && usages.some(u => u.id === focusId) ? focusId : undefined,
    web: web ? { ...web.status, hasPassword: !!accountStore.getConfig().webPasswordHash } : undefined
  }
}

/** 웹 페이지로 보기: 설정대로 서버를 켜고 끈다. */
function applyWeb() {
  const c = accountStore.getConfig()
  web?.apply({ enabled: c.webEnabled === true, remote: c.webRemote === true, port: c.webPort ?? DEFAULT_WEB_PORT, passwordHash: c.webPasswordHash })
}

function broadcastState() {
  const state = getAppState()
  web?.push()
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send(IPC_CHANNELS.STATE_CHANGED, state)
  }
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send(IPC_CHANNELS.STATE_CHANGED, state)
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(IPC_CHANNELS.STATE_CHANGED, state)
  }
  // 정보·업데이트 창도 확인 중·받는 중·준비됨을 바로 보여 준다
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.webContents.send(IPC_CHANNELS.STATE_CHANGED, state)
  }
  if (statsWindow && !statsWindow.isDestroyed()) {
    statsWindow.webContents.send(IPC_CHANNELS.STATE_CHANGED, state)
  }
}



/* ---------- 마우스 설명 창 ---------- */
// 작은 위젯 창 안에 그리면 잘리므로 창 밖까지 나오는 별도 창에 띄운다. 클릭은 통과시킨다.
const TIP_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden}
#t{display:block;width:max-content;max-width:300px;padding:7px 10px;border-radius:7px;font:12px/1.5 "Segoe UI Variable Text","Segoe UI","Malgun Gothic",sans-serif;
background:var(--bg);color:var(--fg);border:1px solid var(--line);box-shadow:0 6px 18px rgba(0,0,0,.28);white-space:pre-wrap;word-break:keep-all}
#t b{display:block;font-weight:650;margin-bottom:1px}#t span{display:block;color:var(--sub)}
</style></head><body><div id="t"></div><script>
window.setTip=(lines,dark)=>{const t=document.getElementById('t'),s=document.documentElement.style
s.setProperty('--bg',dark?'#1d1e24':'#ffffff');s.setProperty('--fg',dark?'#ececf1':'#1d1e24');s.setProperty('--sub',dark?'#a3a4ae':'#666774');s.setProperty('--line',dark?'#3a3b45':'#d9dae2')
t.replaceChildren(...lines.map((l,i)=>{const e=document.createElement(i?'span':'b');e.textContent=l;return e}))
const r=t.getBoundingClientRect();return{w:Math.ceil(r.width),h:Math.ceil(r.height)}}
</script></body></html>`
let tipWindow: BrowserWindow | null = null
let tipReady: Promise<void> | null = null
let tipSeq = 0
function ensureTipWindow() {
  if (tipWindow && !tipWindow.isDestroyed()) return tipReady!
  tipWindow = new BrowserWindow({ width: 10, height: 10, frame: false, transparent: true, show: false, focusable: false, skipTaskbar: true,
    resizable: false, hasShadow: false, alwaysOnTop: true, title: '설명', webPreferences: { nodeIntegration: false, contextIsolation: true } })
  tipWindow.setIgnoreMouseEvents(true)
  tipWindow.setAlwaysOnTop(true, 'screen-saver', 10000)
  tipReady = tipWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TIP_HTML)).catch(() => {})
  return tipReady
}
function hideTip() {
  tipSeq++
  if (tipWindow && !tipWindow.isDestroyed() && tipWindow.isVisible()) tipWindow.hide()
}
async function showTip(sender: Electron.WebContents, text: string, rect: { x: number; y: number; width: number; height: number }) {
  const seq = ++tipSeq
  const win = BrowserWindow.fromWebContents(sender)
  if (!win || win.isDestroyed() || !text) return
  // 요소 좌표는 창 내용 기준(DIP). 작업표시줄에 도킹된 위젯은 Electron 좌표가 작업표시줄 기준이라 실제 화면 위치를 따로 구한다.
  let origin = win.getContentBounds()
  if (win === widgetWindow && accountStore.getConfig().placementMode === 'docked') {
    const r = await TaskbarDocker.getWidgetScreenRect(win)
    if (r) origin = { ...origin, x: r.x, y: r.y }
  }
  await ensureTipWindow()
  if (seq !== tipSeq || !tipWindow || tipWindow.isDestroyed()) return
  const c = accountStore.getConfig().appearance || 'dark'
  const dark = c === 'system' ? nativeTheme.shouldUseDarkColors : c !== 'light'
  const size = await tipWindow.webContents.executeJavaScript(`setTip(${JSON.stringify(String(text).split('\n').slice(0, 12))}, ${dark})`).catch(() => null) as { w: number; h: number } | null
  if (!size || seq !== tipSeq || tipWindow.isDestroyed()) return
  const t = { x: origin.x + rect.x, y: origin.y + rect.y, w: rect.width, h: rect.height }
  const area = screen.getDisplayNearestPoint({ x: Math.round(t.x + t.w / 2), y: Math.round(t.y) }).workArea
  const x = Math.max(area.x + 4, Math.min(t.x + t.w / 2 - size.w / 2, area.x + area.width - size.w - 4))
  // 아래에 자리가 없으면(작업표시줄 도킹 등) 위에 띄운다.
  const below = t.y + t.h + 6
  const y = below + size.h <= area.y + area.height ? below : Math.max(area.y, t.y - size.h - 6)
  tipWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: size.w, height: size.h })
  // 위젯도 '항상 위' 창이라, 숨겼다 다시 보이는 설명 창은 예전 순서 그대로면 위젯을 누른 뒤 그 뒤에 깔린다. 띄울 때마다 맨 앞으로 올린다.
  tipWindow.setAlwaysOnTop(true, 'screen-saver', 10000)
  tipWindow.showInactive()
  tipWindow.moveTop()
}

/* ---------- 모니터별 배치 ---------- */
// 모니터 구성(위치·해상도·배율)마다 자유 창 위치·크기와 디자인을 기억했다가, 구성이 바뀌면 되살린다.
function monitorKey() {
  return screen.getAllDisplays().map(d => `${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}`).sort().join('|')
}
function rememberLayout() {
  const c = accountStore.getConfig()
  if (c.rememberPerMonitor === false || c.placementMode === 'docked' || !c.windowBounds) return
  accountStore.saveConfig({ ...c, layoutsByMonitor: { ...c.layoutsByMonitor, [monitorKey()]: { windowBounds: c.windowBounds, design: c.design } } })
}
/** 지금 모니터 구성에 저장된 배치가 있으면 설정에 적용한다. 적용했으면 true. */
function restoreLayout() {
  const c = accountStore.getConfig(), saved = c.layoutsByMonitor?.[monitorKey()]
  if (c.rememberPerMonitor === false || !saved?.windowBounds) return false
  accountStore.saveConfig({ ...c, windowBounds: saved.windowBounds, design: saved.design || c.design })
  return true
}
// 서비스 종류별 사용량 웹페이지. 렌더러는 계정 ID만 보내고 주소는 여기서 정한다.
/** 카드 우클릭 메뉴. 기본 메뉴라 작은 위젯에서도 잘리지 않는다. */
async function showCardMenu(sender: Electron.WebContents, id: string) {
  const acc = accountStore.getAccounts().find(a => a.id === id)
  const win = BrowserWindow.fromWebContents(sender)
  if (!acc || !win) return
  // 이 서비스의 CLI·데스크톱 앱(못 찾으면 흐리게)
  const cli = acc.launchCli || findCli(acc.provider), app = acc.launchApp || await findApp(acc.provider).catch(() => null)
  if (win.isDestroyed()) return
  const cfg = accountStore.getConfig(), usage = quotaManager?.getUsages().find(u => u.id === id)
  const save = (patch: Partial<WidgetConfig>) => { accountStore.saveConfig({ ...accountStore.getConfig(), ...sanitizeConfigPatch(patch) }); broadcastState() }
  const src = cfg.valueSource?.[id] || 'weekly', disp = displayOf(cfg, id)
  const accounts = accountStore.getAccounts(), index = accounts.findIndex(a => a.id === id)
  const url = servicePageUrl(id)
  Menu.buildFromTemplate([
    { label: acc.name, enabled: false },
    // Esc는 집중 모드를 끌 때만 쓰이므로 켜져 있을 때만 보여 준다
    { label: '집중 모드', type: 'checkbox', checked: focusId === id, ...(focusId === id ? { accelerator: 'Esc', registerAccelerator: false } : {}), click: () => setFocus(id) },
    { type: 'separator' },
    { label: 'CLI 열기  (Ctrl+두 번 클릭)', enabled: !!cli, click: () => { openCli(acc) } },
    { label: '앱 열기  (Shift+두 번 클릭)', enabled: !!app, click: () => { void openApp(acc) } },
    { type: 'separator' },
    { label: '이 서비스 통계', click: () => openStatsWindow(id) },
    { label: '새로고침', click: () => { if (!isPreview) void quotaManager.refreshAll().then(() => broadcastState()) } },
    ...(url ? [{ label: '공식 사용량 페이지 열기', click: () => { void shell.openExternal(url) } }] : []),
    { type: 'separator' },
    { label: '큰 숫자 기준', submenu: ([['weekly', '주간'], ['5h', firstWindowLabel(usage?.primaryKind)], ['tight', '빠듯한 쪽']] as const).map(([k, label]) => ({
      label, type: 'radio' as const, checked: src === k, click: () => save({ valueSource: { ...accountStore.getConfig().valueSource, [id]: k } }) })) },
    { label: '보여 줄 정보', submenu: DISPLAY_KEYS.map(([k, label]) => ({ label: k === 'showUsed' ? '쓴 양으로 표시' : k === 'showReset' ? '리셋까지 남은 시간' : label, type: 'checkbox' as const, checked: disp[k],
      click: (item: Electron.MenuItem) => save(setDisplay(accountStore.getConfig(), id, k, item.checked)) })) },
    { type: 'separator' },
    { label: '앞으로 옮기기', enabled: index > 0, click: () => { accountStore.reorderAccount(id, 'up'); broadcastState() } },
    { label: '뒤로 옮기기', enabled: index < accounts.length - 1, click: () => { accountStore.reorderAccount(id, 'down'); broadcastState() } },
    { label: '카드 위치 고정', type: 'checkbox', checked: !!cfg.lockCards, click: item => save({ lockCards: item.checked }) },
    { type: 'separator' },
    { label: '작업 표시줄에서만 숨기기', type: 'checkbox', visible: dockSupported, checked: !!acc.hiddenInDock, click: item => { accountStore.patchAccountDisplay(id, { hiddenInDock: item.checked }); broadcastState(); if (accountStore.getConfig().placementMode === 'docked') void updateWidgetBounds() } },
    { label: '이 카드 숨기기', click: () => { accountStore.hideAccount(id, true); broadcastState() } },
    { type: 'separator' },
    { label: '서비스 설정…', click: () => openSettingsWindow('services') },
  ]).popup({ window: win })
}

function servicePageUrl(accountId: string) {
  const acc = accountStore.getAccounts().find(a => a.id === accountId)
  const key = `${acc?.provider || ''} ${acc?.name || ''}`.toLowerCase()
  if (key.includes('claude')) return 'https://claude.ai/settings/usage'
  if (key.includes('codex') || key.includes('openai') || key.includes('gpt')) return 'https://chatgpt.com/codex/settings/usage'
  if (key.includes('xai') || key.includes('grok')) return 'https://grok.com/'
  if (key.includes('cursor')) return 'https://cursor.com/dashboard?tab=usage'
  if (key.includes('copilot')) return 'https://github.com/settings/copilot/features'
  return null
}

/* ---------- 클릭 통과 잠금·전역 단축키 ---------- */
// 잠그면 위젯 위 클릭이 뒤 창으로 간다(자유 창 전용). 마우스로는 풀 수 없으므로 단축키·트레이로 푼다.
function applyClickThrough() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  const c = accountStore.getConfig()
  const locked = !!c.clickThrough && c.placementMode !== 'docked'
  widgetWindow.setIgnoreMouseEvents(locked, locked ? { forward: true } : undefined)
}
function setClickThrough(on: boolean) {
  accountStore.saveConfig({ ...accountStore.getConfig(), clickThrough: on })
  applyClickThrough()
  updateTrayMenu()
  broadcastState()
}
async function toggleWidgetVisibility() {
  if (!widgetWindow) return
  if (widgetWindow.isVisible()) {
    widgetManuallyHidden = true
    widgetWindow.hide()
    hidePopup(true)
  } else {
    widgetManuallyHidden = false
    widgetHiddenForFullscreen = false
    widgetWindow.show()
    await updateWidgetBounds()
  }
}
/** 숨긴 창(또는 독)을 다시 보이고 창은 맨 앞으로 가져온다. 이미 보이면 숨기지 않는다. */
async function showWidgetWindow() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  widgetManuallyHidden = false
  widgetHiddenForFullscreen = false
  if (widgetWindow.isMinimized()) widgetWindow.restore()
  if (!widgetWindow.isVisible()) { widgetWindow.show(); await updateWidgetBounds() }
  if (accountStore.getConfig().placementMode !== 'docked') widgetWindow.moveTop()
}
function cycleDesign() {
  const c = accountStore.getConfig(), ids = DESIGNS.map(d => d[0])
  const next = ids[(ids.indexOf(c.design || 'rich') + 1) % ids.length]
  accountStore.saveConfig({ ...c, design: next })
  rememberLayout()
  broadcastState()
}
function registerShortcuts() {
  globalShortcut.unregisterAll()
  shortcutErrors = []
  const s = accountStore.getConfig().shortcuts || {}
  const actions: Array<[string | undefined, string, () => void]> = [
    [s.toggle, '창·작업 표시줄 독 보이기/숨기기', () => { void toggleWidgetVisibility() }],
    [s.lock, '클릭 통과 잠금', () => setClickThrough(!accountStore.getConfig().clickThrough)],
    [s.cycle, '디자인 순환', cycleDesign],
  ]
  for (const [accel, label, run] of actions) {
    if (!accel) continue
    let ok = false
    try { ok = globalShortcut.register(accel, run) } catch { ok = false }
    // 다른 앱이 이미 쓰는 조합이거나 형식이 잘못된 경우
    if (!ok) shortcutErrors.push(`${label}(${accel})`)
  }
}

/* ---------- 설정 창: 큰 미리보기 + 조절 항목. 위젯이 작아도 편하게 편집하고, 바꾸면 위젯에도 즉시 반영된다. ---------- */
const SETTINGS_TABS = ['design', 'display', 'services', 'alerts', 'general', 'convenience', 'accounts', 'api', 'last'] as const
type SettingsTab = typeof SETTINGS_TABS[number]
// 설정 창도 위젯과 같은 배경(불투명도·아크릴)을 쓰도록 테두리 없는 공통 창으로 만들고, 창 단추는 화면이 그린다.
let aboutWindow: SurfaceWindow | null = null
let statsWindow: SurfaceWindow | null = null
/** 스케일(설정의 %): 창 전체 확대·축소. 작업 표시줄에 붙은 위젯은 작업 표시줄 높이에 맞춰야 하므로 늘 1. */
const uiZoom = () => Math.max(.8, Math.min(1.5, (accountStore?.getConfig().fontScale ?? 100) / 100))
function applyZoom() {
  const z = uiZoom(), docked = accountStore.getConfig().placementMode === 'docked'
  const set = (w: { isDestroyed(): boolean; webContents: Electron.WebContents } | null | undefined, f: number) => { if (w && !w.isDestroyed() && Math.abs(w.webContents.getZoomFactor() - f) > .001) w.webContents.setZoomFactor(f) }
  set(widgetWindow, docked ? 1 : z); set(popupWindow, z); set(settingsWindow, z); set(aboutWindow, z); set(statsWindow, z)
}
/** 스케일이 바뀐 비율만큼 창 크기를 바꾼다(왼쪽 위는 그대로, 화면 안으로). 작업 표시줄에 붙은 위젯은 빼고. */
function rescaleWindows(ratio: number) {
  const docked = accountStore.getConfig().placementMode === 'docked'
  const resize = (w: SurfaceWindow | null, save?: (b: Electron.Rectangle) => void) => {
    if (!w || w.isDestroyed()) return
    const b = w.getBounds(), area = screen.getDisplayMatching(b).workArea
    const next = fitWindow({ x: b.x, y: b.y, width: Math.min(area.width, Math.round(b.width * ratio)), height: Math.min(area.height, Math.round(b.height * ratio)) }, area)
    w.setBounds(next)
    save?.(next)
  }
  if (!docked) resize(widgetWindow, b => { accountStore.saveConfig({ ...accountStore.getConfig(), windowBounds: b }); rememberLayout() })
  else { const wb = accountStore.getConfig().windowBounds; if (wb) accountStore.saveConfig({ ...accountStore.getConfig(), windowBounds: { ...wb, width: Math.round(wb.width * ratio), height: Math.round(wb.height * ratio) } }) }
  const pb = accountStore.getConfig().popupBounds
  if (popupWindow && !popupWindow.isDestroyed() && popupWindow.isVisible()) resize(popupWindow, b => savePopupBounds(b))
  else if (pb) accountStore.saveConfig({ ...accountStore.getConfig(), popupBounds: { ...pb, width: Math.round(pb.width * ratio), height: Math.round(pb.height * ratio) } })
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    // 최소 크기도 스케일을 따라야 줄였을 때 배치가 깨지지 않는다
    const area = screen.getDisplayMatching(settingsWindow.getBounds()).workArea
    settingsWindow.setMinimumSize(Math.min(area.width - 40, Math.round(760 * uiZoom())), Math.min(area.height - 40, Math.round(520 * uiZoom())))
  }
  resize(settingsWindow); resize(aboutWindow); resize(statsWindow)
  broadcastState() // 설정 미리보기가 바뀐 위젯 크기를 따라가게
}

/** 창이 페이지를 다시 읽으면 확대 비율이 처음으로 돌아가므로 그때마다 다시 맞춘다. */
function keepZoom(w: { webContents: Electron.WebContents }) { w.webContents.on('did-finish-load', () => applyZoom()) }

/** 계정마다 자동으로 찾은 CLI·앱. 설정 화면에 보여 주려고 따로 기억한다. */
let launchers: Record<string, { cli?: string; app?: string }> = {}
async function refreshLaunchers() {
  const next: typeof launchers = {}
  for (const a of accountStore.getAccounts()) {
    const app = await findApp(a.provider).catch(() => null)
    next[a.id] = { cli: findCli(a.provider) || undefined, app: app?.name }
  }
  launchers = next
  broadcastState()
}

/** '정보·업데이트' 창. 하나만 띄운다. */
function openAboutWindow() {
  // 위젯에서 열어도 위젯은 그대로 둔다. 정보 창으로 초점이 옮겨 가도 닫히지 않게 고정하고, 정보 창은 위젯 위에 띄운다(syncDialogTopmost).
  if (popupWindow && !popupWindow.isDestroyed() && popupWindow.isVisible()) { cancelHidePopup(); isPopupLocked = true }
  if (aboutWindow && !aboutWindow.isDestroyed()) { if (aboutWindow.isMinimized()) aboutWindow.restore(); aboutWindow.show(); aboutWindow.focus(); return }
  const anchor = widgetWindow && !widgetWindow.isDestroyed() ? widgetWindow.getBounds() : screen.getPrimaryDisplay().bounds
  const area = screen.getDisplayMatching(anchor).workArea, width = Math.min(area.width - 40, Math.round(460 * uiZoom())), height = Math.min(Math.round(680 * uiZoom()), area.height - 40) // 스케일만큼 키워 배치를 그대로
  const win = aboutWindow = new SurfaceWindow({
    x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height,
    show: false, title: 'AI 사용량 정보', resizable: false, maximizable: false, minimizable: false, autoHideMenuBar: true,
    webPreferences: { preload: getPreloadPath(), nodeIntegration: false, contextIsolation: true }
  }, currentSurfaceKind())
  keepZoom(win)
  win.on('page-title-updated', event => event.preventDefault())
  win.once('ready-to-show', () => { syncDialogTopmost(); win.show(); applyWindowShape(win, 'native') })
  win.on('focus', syncDialogTopmost)
  win.on('closed', () => { if (aboutWindow === win) aboutWindow = null })
  if (process.env.VITE_DEV_SERVER_URL) void win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?view=about`)
  else void win.loadFile(path.join(__dirname, '../dist/index.html'), { query: { view: 'about' } })
}

/** 사용량 통계 창. id를 주면 그 서비스를 앞에 보여 준다(카드 우클릭 '이 서비스 통계'). */
function openStatsWindow(id?: string) {
  if (statsWindow && !statsWindow.isDestroyed()) {
    if (id) statsWindow.webContents.send(IPC_CHANNELS.OPEN_STATS, id)
    if (statsWindow.isMinimized()) statsWindow.restore()
    statsWindow.show(); statsWindow.focus()
    return
  }
  hidePopup(true)
  const anchor = widgetWindow && !widgetWindow.isDestroyed() ? widgetWindow.getBounds() : screen.getPrimaryDisplay().bounds
  const area = screen.getDisplayMatching(anchor).workArea
  const width = Math.min(area.width - 40, Math.round(820 * uiZoom())), height = Math.min(area.height - 40, Math.round(640 * uiZoom()))
  const win = statsWindow = new SurfaceWindow({
    x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height,
    minWidth: Math.min(area.width - 40, Math.round(420 * uiZoom())), minHeight: Math.min(area.height - 40, Math.round(360 * uiZoom())),
    show: false, title: 'AI 사용량 통계', autoHideMenuBar: true,
    webPreferences: { preload: getPreloadPath(), nodeIntegration: false, contextIsolation: true }
  }, currentSurfaceKind())
  keepZoom(win)
  win.on('page-title-updated', event => event.preventDefault())
  win.once('ready-to-show', () => { syncDialogTopmost(); win.show(); applyWindowShape(win, 'native') })
  win.on('focus', syncDialogTopmost)
  win.on('resize', () => { if (!win.isDestroyed()) applyWindowShape(win, win.isMaximized() ? 0 : 'native') })
  win.on('closed', () => { if (statsWindow === win) statsWindow = null })
  const query = { view: 'stats', ...(id ? { id } : {}) }
  if (process.env.VITE_DEV_SERVER_URL) void win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${new URLSearchParams(query)}`)
  else void win.loadFile(path.join(__dirname, '../dist/index.html'), { query })
}

function openSettingsWindow(tab: SettingsTab = 'design', bounds?: Electron.Rectangle) {
  void refreshLaunchers()
  if (!SETTINGS_TABS.includes(tab)) tab = 'design'
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(IPC_CHANNELS.SETTINGS_TAB, tab)
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show(); settingsWindow.focus()
    return
  }
  hidePopup(true)
  const anchor = widgetWindow && !widgetWindow.isDestroyed() ? widgetWindow.getBounds() : screen.getPrimaryDisplay().bounds
  const area = screen.getDisplayMatching(anchor).workArea
  const width = Math.min(Math.round(1000 * uiZoom()), area.width - 40), height = Math.min(Math.round(680 * uiZoom()), area.height - 40) // 스케일만큼 키워 배치를 그대로
  const win = settingsWindow = new SurfaceWindow({
    ...(bounds || { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height }),
    minWidth: Math.min(area.width - 40, Math.round(760 * uiZoom())), minHeight: Math.min(area.height - 40, Math.round(520 * uiZoom())), show: false, title: 'AI 사용량 설정', resizable: true, maximizable: true, autoHideMenuBar: true,
    webPreferences: { preload: getPreloadPath(), nodeIntegration: false, contextIsolation: true }
  }, currentSurfaceKind())
  keepZoom(win)
  win.on('page-title-updated', event => event.preventDefault())
  win.once('ready-to-show', () => { syncDialogTopmost(); win.show(); applyWindowShape(win, 'native') })
  win.on('focus', syncDialogTopmost)
  win.on('closed', () => { if (settingsWindow === win) settingsWindow = null })
  if (process.env.VITE_DEV_SERVER_URL) void settingsWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?view=settings&tab=${tab}`)
  else void settingsWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: { view: 'settings', tab } })
}

const shapeKeys=new WeakMap<BrowserWindow,string>()
// 'native'은 Windows 11 DWM 둥근 모서리. setShape는 웹 내용만 자르고 아크릴 backdrop은 사각형으로 남기므로
// 아크릴 창은 DWM 모서리(8px)를 쓰고 CSS 반경도 같은 값으로 맞춘다.
function applyWindowShape(win: BrowserWindow, radius: number | 'native') {
  if(process.platform!=='win32' || win.isDestroyed()) return
  const [width,height]=win.getSize()
  const key=radius==='native' ? 'native' : `${width}:${height}:${radius}`
  if(shapeKeys.get(win)===key) return
  // setShape는 그 자리에서 resize 이벤트를 다시 일으키므로 먼저 기록해 재귀 호출을 막는다.
  shapeKeys.set(win,key)
  if(radius==='native') {
    win.setShape([])
    TaskbarDocker.setCornerPreference(win,'round')
  } else {
    const dockHeight=radius===0 ? getTaskbarInfo(screen.getDisplayMatching(win.getBounds())).taskbarHeight : height
    win.setShape(radius>0 ? roundedWindowShape(width,height,radius) : [{x:0,y:0,width,height:dockHeight}])
    if(radius===0) TaskbarDocker.setCornerPreference(win,'none')
  }
}

const currentSurfaceKind = () => surfaceKind(accountStore.getConfig(), acrylicSupported)

// 창 모양·아크릴 유지를 다시 맞춘다. 배경 종류(흐림 가능/흐림 없는 투명)가 바뀌었으면 창을 다시 만든다.
function applySurface() {
  const config=accountStore.getConfig()
  nativeTheme.themeSource=config.appearance || 'dark'
  const kind=currentSurfaceKind()
  if([widgetWindow,popupWindow,settingsWindow].some(w=>w && !w.isDestroyed() && w.kind!==kind)) { scheduleSurfaceRebuild(); return }
  for(const win of [widgetWindow,popupWindow]) {
    if(!win || win.isDestroyed()) continue
    // CSS만 둥글게 하면 DWM 아크릴은 사각형으로 남는다. 실제 그리기·히트 테스트 영역도 맞춘다.
    shapeKeys.delete(win)
    applyWindowShape(win,win===widgetWindow && config.placementMode==='docked' ? 0 : 'native')
    win.keepBackdrop()
  }
}

// 슬라이더를 끄는 동안 창이 여러 번 바뀌지 않게, 조작이 멈춘 뒤 한 번만 다시 만든다.
let surfaceRebuildTimer: NodeJS.Timeout | undefined
function scheduleSurfaceRebuild() {
  clearTimeout(surfaceRebuildTimer)
  surfaceRebuildTimer=setTimeout(rebuildSurfaces,450)
}
function rebuildSurfaces() {
  if(interacting) { scheduleSurfaceRebuild(); return }
  const kind=currentSurfaceKind()
  if(widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.kind!==kind) {
    const old=widgetWindow
    if(accountStore.getConfig().placementMode==='floating') accountStore.saveConfig({ ...accountStore.getConfig(), windowBounds: old.getBounds() })
    TaskbarDocker.stopDockWatcher()
    TaskbarDocker.stopStayTop()
    widgetWindow=null
    old.destroy()
    createWidgetWindow()
    startFullscreenWatch()
  }
  if(popupWindow && !popupWindow.isDestroyed() && popupWindow.kind!==kind) {
    hidePopup(true)
    const old=popupWindow
    popupWindow=null
    old.destroy()
    createPopupWindow()
  }
  if(settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.kind!==kind) {
    const old=settingsWindow, bounds=old.getNormalBounds()
    settingsWindow=null
    // 보던 탭을 그대로 연다(배경을 바꾸려고 디자인 탭이 아닌 곳에서 바꿨을 수 있다).
    void old.webContents.executeJavaScript(`document.querySelector('[role=tab][aria-selected=true]')?.dataset.tab||''`).catch(()=>'').then((tab: string) => {
      old.destroy()
      openSettingsWindow((SETTINGS_TABS as readonly string[]).includes(tab) ? tab as SettingsTab : 'design',bounds)
    })
  }
}

function applyWindowTopmost(config: WidgetConfig) {
  syncDialogTopmost()
  if (!widgetWindow || widgetWindow.isDestroyed()) return

  if (config.placementMode === 'floating') {
    // 플로팅 모드는 Electron의 네이티브 alwaysOnTop 제어
    const isAlwaysTop = config.alwaysOnTop !== false
    if (isAlwaysTop) {
      widgetWindow.setAlwaysOnTop(true, 'floating')
    } else {
      widgetWindow.setAlwaysOnTop(false)
      TaskbarDocker.stopStayTop()
    }
  } else {
    // [중요 원칙]: 작업표시줄 child HWND 도킹 모드에서는 setAlwaysOnTop 및 staytop을 일절 사용하지 않음
    TaskbarDocker.stopStayTop()
    widgetWindow.setAlwaysOnTop(false)
  }
}

/**
 * 핀(항상 위)을 켠 창은 '항상 위' 층에 있어서, 보통 창인 설정·정보·통계 창은 겹치면 늘 그 뒤로 숨는다.
 * 핀이 켜져 있으면 이 창들도 같은 층(floating)에 올려, 나중에 띄우거나 누른 창이 위에 오게 한다.
 */
function syncDialogTopmost() {
  const c = accountStore.getConfig(), pinned = c.placementMode === 'floating' && c.alwaysOnTop !== false
  // 위젯은 항상 위에 떠 있으므로, 위젯이 보이는 동안 정보 창도 항상 위로 올려야 위젯에 가리지 않는다.
  const overPopup = !!popupWindow && !popupWindow.isDestroyed() && popupWindow.isVisible()
  for (const w of [settingsWindow, aboutWindow, statsWindow]) {
    if (!w || w.isDestroyed()) continue
    const top = pinned || (w === aboutWindow && overPopup)
    w.setAlwaysOnTop(top, 'floating')
    if (top && w.isFocused()) w.moveTop()
  }
}

// 레이아웃(dock/undock/setBounds)은 동시 실행 시 서로의 HWND 상태를 덮어쓰므로 직렬 큐로 실행
let layoutQueue: Promise<void> = Promise.resolve()
let dockRepairPending = false
let dockRepairTimes: number[] = []
let dockRetryTimer: ReturnType<typeof setTimeout> | undefined
let dockRetryCount = 0

function updateWidgetBounds(): Promise<void> {
  layoutQueue = layoutQueue
    .then(layoutWidget)
    .catch((err) => console.error('[Main] Widget layout failed:', err))
  return layoutQueue
}

async function layoutWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  const config = accountStore.getConfig()
  const isFloating = config.placementMode === 'floating'

  if (isFloating) {
    dockRepairPending = false
    TaskbarDocker.stopDockWatcher()
    widgetWindow.setMinimumSize(MIN_WINDOW_SIZE.width, MIN_WINDOW_SIZE.height)
    widgetWindow.setResizable(false)
    const bounds = floatingBounds(config)
    currentWidgetWidth = bounds.width
    currentWidgetHeight = bounds.height
    widgetWindow.setBounds(bounds)
    return
  }

  widgetWindow.setMinimumSize(1, 1)
  widgetWindow.setResizable(false)

  // Chromium viewport와 HWND 크기를 실제 위젯 크기로 동기화
  widgetWindow.setContentSize(currentWidgetWidth, currentWidgetHeight, false)

  // 네이티브 작업표시줄 도킹 실행 (실제 위젯 높이 currentWidgetHeight 전달)
  const res = await TaskbarDocker.dockWindow(widgetWindow, config, currentWidgetWidth, currentWidgetHeight)
  if (res.success) {
    dockRepairPending = false
    dockRetryCount = 0
    clearTimeout(dockRetryTimer)
    TaskbarDocker.startDockWatcher(
      widgetWindow,
      () => handleDockedWidgetClick(),
      () => {
        // 탐색기가 다시 시작되면 다시 붙인다. 붙여도 바로 또 풀리는 상태(작업표시줄 자식이 되지 못함)면 끝없이 반복되므로 5초에 3번까지만.
        const now = Date.now()
        dockRepairTimes = dockRepairTimes.filter(t => now - t < 5000).concat(now)
        if (dockRepairTimes.length > 3) {
          // 붙이자마자 풀리기를 반복하면 잠시 쉬었다가 한 번 더 붙인다(클릭·끌기가 죽은 채로 남지 않게).
          console.warn('[Main] Dock keeps getting lost; retrying in 30s')
          TaskbarDocker.stopDockWatcher()
          clearTimeout(dockRetryTimer)
          dockRetryTimer = setTimeout(() => { dockRepairTimes = []; dockRepairPending = true; void updateWidgetBounds() }, 30000)
          return
        }
        console.log('[Main] Explorer restart or dock lost detected, re-docking widget...')
        dockRepairPending = true
        updateWidgetBounds()
      },
      () => { void beginWindowInteraction('move') }
    )
  } else if (dockRepairPending && dockRetryCount < 20) {
    // Explorer 재시작 직후에는 작업표시줄이 아직 없을 수 있으므로 복구 중일 때만 재시도. 여러 곳에서 불려도 예약은 하나만, 1분까지.
    dockRetryCount++
    clearTimeout(dockRetryTimer)
    dockRetryTimer = setTimeout(() => updateWidgetBounds(), 3000)
  } else {
    dockRepairPending = false
    dockRetryCount = 0
    console.warn('[Window] Dock unavailable, restoring floating window:', res.error)
    await TaskbarDocker.undockWindow(widgetWindow)
    accountStore.saveConfig({ ...accountStore.getConfig(), placementMode: 'floating' })
    widgetWindow.setMinimumSize(MIN_WINDOW_SIZE.width, MIN_WINDOW_SIZE.height)
    widgetWindow.setResizable(false)
    widgetWindow.setBounds(floatingBounds(accountStore.getConfig()))
    applyWindowTopmost(accountStore.getConfig())
    broadcastState()
  }
}

function createWidgetWindow() {
  const config = accountStore.getConfig()
  const isFloating = config.placementMode === 'floating'
  const initialBounds = isFloating ? floatingBounds(config) : { ...TaskbarDocker.calculatePosition(config, currentWidgetWidth, currentWidgetHeight), width: currentWidgetWidth, height: currentWidgetHeight }
  const { x, y } = initialBounds
  currentWidgetWidth = initialBounds.width
  currentWidgetHeight = initialBounds.height

  console.log(`[Widget] Creating widget window at (${x}, ${y}) size ${currentWidgetWidth}x${currentWidgetHeight} mode=${config.placementMode || 'docked'}`)

  const win = widgetWindow = new SurfaceWindow({
    x,
    y,
    width: currentWidgetWidth,
    height: currentWidgetHeight,
    alwaysOnTop: isFloating && (config.alwaysOnTop !== false),
    skipTaskbar: true,
    resizable: false, // 투명 HWND의 기본 리사이즈 충돌을 피하고 8방향 사용자 핸들로 조절한다.
    hasShadow: false,
    focusable: true, // 마우스 클릭 이벤트가 정상적으로 DOM에 전달되도록 true 유지
    show: false,
    title: 'AI 사용량',
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  }, currentSurfaceKind())
  keepZoom(win)

  if (isFloating && config.alwaysOnTop !== false) {
    widgetWindow.setAlwaysOnTop(true, 'floating')
  }
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  widgetWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[WidgetWindow] Load failed:', code, desc, url)
  })

  widgetWindow.webContents.on('console-message', (_e, _level, msg) => {
    console.log('[WidgetWindow Console]:', msg)
  })

  widgetWindow.once('ready-to-show', async () => {
    widgetWindow?.showInactive()
    await updateWidgetBounds()
    if (widgetWindow) {
      applyWindowTopmost(accountStore.getConfig())
      applySurface()
      applyClickThrough()
    }
    // 첫 드래그에서 안내 창 생성·로드가 끊김을 만들지 않도록 유휴 시간에 미리 만든다.
    setTimeout(() => { if (!interacting) showDockPreview(false, undefined, true); void ensureTipWindow() }, 1500)
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    widgetWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#view=widget`)
  } else {
    widgetWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'view=widget', query: { view: 'widget' } })
  }

  widgetWindow.on('closed', () => {
    if (widgetWindow === win) widgetWindow = null
  })
  widgetWindow.on('resized', saveFloatingBounds)
  widgetWindow.on('moved', saveFloatingBounds)
  widgetWindow.on('resize',()=>{if(widgetWindow)applyWindowShape(widgetWindow,accountStore.getConfig().placementMode==='docked'?0:'native')})
}

function floatingBounds(config: WidgetConfig) {
  const saved = config.windowBounds
  const area = saved ? screen.getDisplayMatching(saved).workArea : screen.getPrimaryDisplay().workArea
  return fitWindow(saved || { x: area.x + (area.width - DEFAULT_WINDOW_SIZE.width) / 2,
    y: area.y + Math.max(32, (area.height - DEFAULT_WINDOW_SIZE.height) / 2), ...DEFAULT_WINDOW_SIZE }, area)
}

let boundsSaveTimer: NodeJS.Timeout | undefined
let pointerProcess: { stop(): void } | null = null
let interacting = false
let endInteraction: ((p?: {x:number;y:number}) => Promise<void>) | null = null
let dockGhost: BrowserWindow | null = null
let dockPreviewVisible = false

function saveFloatingBounds() {
  clearTimeout(boundsSaveTimer)
  boundsSaveTimer = setTimeout(() => {
    if (!interacting && widgetWindow && !widgetWindow.isDestroyed() && accountStore.getConfig().placementMode === 'floating') {
      accountStore.saveConfig({ ...accountStore.getConfig(), windowBounds: widgetWindow.getBounds() })
      rememberLayout()
    }
  }, 180)
}

function dockWidth() {
  const state=getAppState()
  const n = state.focus ? 1 : visibleUsages(state.usages,state.accounts,state.config,true).length
  return Math.max(80,24+136*n)
}

/** 마우스를 놓으면 위젯이 들어갈 작업표시줄 자리. 미리보기와 실제 도킹이 같은 계산을 쓴다. */
// 모니터마다 작업표시줄에서 쓸 수 있는 오른쪽 끝(알림 영역·시계 왼쪽, DIP). 실제로 붙을 때 보조 프로그램이 그 왼쪽에서 멈추므로
// 미리보기도 같은 자리에서 멈춰야 놓은 뒤 위치가 튀지 않는다. 끌기를 시작할 때마다 새로 읽는다(트레이 아이콘 수가 바뀔 수 있음).
const usableRightByDisplay = new Map<number, number>()
function refreshUsableRight() {
  for (const d of screen.getAllDisplays()) void TaskbarDocker.usableRight(d).then(x => { if (x !== null) usableRightByDisplay.set(d.id, x); else usableRightByDisplay.delete(d.id) }).catch(() => {})
}
function dockRight(display: Electron.Display) {
  const edge = display.bounds.x + display.bounds.width, tray = usableRightByDisplay.get(display.id)
  return tray !== undefined && tray > display.bounds.x && tray <= edge ? tray : edge
}

function dockSlot(p: {x:number;y:number}, width = dockWidth()) {
  const display = screen.getDisplayNearestPoint(p)
  const height = getTaskbarInfo(display).taskbarHeight
  const right = dockRight(display)
  const w = Math.min(width, right - display.bounds.x)
  const x = Math.max(display.bounds.x, Math.min(p.x - 100, right - w))
  return { display, rect: { x: Math.round(x), y: display.bounds.y + display.bounds.height - height, width: w, height } }
}

// 도킹 미리보기: 커서 옆 안내 상자 대신 작업표시줄의 실제 들어갈 자리에 위젯 모양을 강조색 윤곽과 함께 보여 준다.
// 드래그 중 매 좌표마다 호출되므로 상태가 그대로면 창 배치를 건너뛴다.
function showDockPreview(visible: boolean, point?: {x:number;y:number}, preload = false, ghostWidth = dockWidth()) {
  if (!visible && !preload) { if (dockPreviewVisible) dockGhost?.hide(); dockPreviewVisible = false; return }
  const cursor = point || screen.getCursorScreenPoint()
  const { rect } = dockSlot(cursor, ghostWidth)
  if (!dockGhost || dockGhost.isDestroyed()) {
    dockGhost = new BrowserWindow({ width: rect.width, height: rect.height, frame: false, transparent: true, show: false, focusable: false, skipTaskbar: true,
      alwaysOnTop: true, hasShadow: false, title: '도킹 미리보기', webPreferences: { preload: getPreloadPath(), nodeIntegration: false, contextIsolation: true } })
    dockGhost.on('page-title-updated', event => event.preventDefault())
    dockGhost.setIgnoreMouseEvents(true)
    dockGhost.setAlwaysOnTop(true, 'screen-saver', 9000)
    dockGhost.webContents.once('did-finish-load', () => {
      dockGhost?.webContents.send(IPC_CHANNELS.STATE_CHANGED, getAppState())
      if (dockPreviewVisible) { dockGhost?.showInactive(); replayDockPreviewEnter() }
    })
    if (process.env.VITE_DEV_SERVER_URL) void dockGhost.loadURL(`${process.env.VITE_DEV_SERVER_URL}?view=dock-preview&dockHeight=${rect.height}`)
    else void dockGhost.loadFile(path.join(__dirname, '../dist/index.html'), { query: { view: 'dock-preview', dockHeight: String(rect.height) } })
  }
  dockGhost.setBounds(rect)
  if (visible && !dockPreviewVisible) {
    // 미리보기는 위젯의 실제 도킹 모습을 그리므로 지금 상태(서비스 목록)를 넘겨준다.
    if (!dockGhost.webContents.isLoading()) dockGhost.webContents.send(IPC_CHANNELS.STATE_CHANGED, getAppState())
    dockGhost.showInactive(); replayDockPreviewEnter()
  } else if (!visible) dockGhost.hide()
  // 커서가 작업표시줄 위에 있으면 작업표시줄이 자기 창을 맨 위로 올려 미리보기를 가린다. 갱신할 때마다 다시 맨 위로 올린다.
  if (visible) dockGhost.moveTop()
  dockPreviewVisible = visible
}
/** 미리보기가 새로 나타날 때마다 등장 애니메이션을 처음부터 다시 재생한다. */
function replayDockPreviewEnter() {
  void dockGhost?.webContents.executeJavaScript("document.body.classList.remove('dock-enter');void document.body.offsetWidth;document.body.classList.add('dock-enter')").catch(() => {})
}

/** 놓았을 때 창이 미리보기 자리로 줄어들며 들어가는 애니메이션(약 0.18초). 아크릴을 깨지 않도록 투명도는 보조 프로그램으로 조절한다. */
async function animateIntoSlot(win: SurfaceWindow, to: Electron.Rectangle, ms = 180) {
  const from = win.getBounds(), t0 = Date.now()
  // 투명 창(흐림 없는 반투명)은 Electron 투명도를, 아크릴 창은 보조 프로그램을 쓴다(setOpacity는 아크릴을 지운다).
  const alpha = (a: number) => { if (win.kind === 'backdrop') void TaskbarDocker.setAlpha(win, a); else win.setOpacity(a / 255) }
  win.setMinimumSize(1, 1)
  const ease = (t: number) => 1 - Math.pow(1 - t, 3)
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / ms), k = ease(t)
    if (win.isDestroyed()) return
    win.setBounds({ x: Math.round(from.x + (to.x - from.x) * k), y: Math.round(from.y + (to.y - from.y) * k),
      width: Math.max(1, Math.round(from.width + (to.width - from.width) * k)), height: Math.max(1, Math.round(from.height + (to.height - from.height) * k)) })
    alpha(Math.round(255 - 150 * k))
    if (t >= 1) break
    await new Promise(r => setTimeout(r, 12))
  }
}

/** floatBounds: 도킹할 때 기억해 둘 자유 창 위치·크기(빨려드는 애니메이션으로 창이 줄어든 상태가 저장되지 않도록). */
async function setPlacement(mode: 'floating' | 'docked', floatBounds?: Electron.Rectangle) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  setTimeout(applyZoom, 0) // 작업 표시줄에 붙으면 1배, 창이 되면 스케일대로
  if (mode === 'docked' && !dockSupported) return
  const previous = accountStore.getConfig()
  if (previous.placementMode === mode) return
  if (mode === 'floating') {
    clearTimeout(dockRetryTimer); dockRepairPending = false
    TaskbarDocker.stopDockWatcher()
    const detached = await TaskbarDocker.undockWindow(widgetWindow)
    if (!detached) throw new Error('작업표시줄에서 창을 분리하지 못했습니다.')
    // 작업표시줄 자식에서 떼어 내면 Chromium이 마우스 입력을 더 받지 못하는 경우가 있다(실측: 위로 끌어 창으로 바꾼 뒤 제목줄·카드가 반응 없음).
    // 창을 한 번 숨겼다 다시 보이면 입력 경로가 되살아난다.
    widgetWindow.hide()
    widgetWindow.showInactive()
  } else {
    clearTimeout(boundsSaveTimer)
    if (previous.placementMode === 'floating') previous.windowBounds = floatBounds || widgetWindow.getBounds()
    TaskbarDocker.stopStayTop()
    widgetWindow.setAlwaysOnTop(false)
    currentWidgetWidth = dockWidth()
    currentWidgetHeight = Math.min(44, getTaskbarInfo(screen.getDisplayMatching(widgetWindow.getBounds())).taskbarHeight)
  }
  accountStore.saveConfig({ ...previous, placementMode: mode })
  await updateWidgetBounds()
  applyWindowTopmost(accountStore.getConfig())
  applySurface()
  applyClickThrough()
  updateTrayMenu()
  hidePopup(true)
  broadcastState()
}

// 자유 창 제스처는 렌더러가 보내는 좌표(프레임마다 한 번)와 보조 프로그램의 실제 커서 좌표를 함께 쓴다.
// 버튼 놓음도 둘 다 감시해 먼저 오는 쪽으로 끝낸다. 렌더러만 믿으면 포인터 잡기가 풀리거나 커서가 작업표시줄 위로 갈 때
// 이동·놓음 신호가 끊겨, 미리보기가 안 뜨거나 놓아도 도킹되지 않는 일이 있었다.
let interactionMove: ((p: {x:number;y:number}) => void) | null = null
/** 작업표시줄 안 끌기에서 창으로 바뀌는 높이: 작업표시줄 위쪽 경계에서 이만큼 올라가면 창이 된다. */
const SLIDE_ESCAPE_PX = 40

/** 크기는 그대로 두고 옮긴다. 배율이 100%가 아닌 화면에서 setPosition은 부를 때마다 반올림 오차로 창을 1px씩 키워
 *  끄는 동안 창이 계속 커졌다(Electron, 실측 125%: 150번 옮기면 248×336 → 443×473). */
function moveKeepingSize(win: BrowserWindow, x: number, y: number, size: { width: number; height: number }) {
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: size.width, height: size.height })
}

/** 끄는 동안 옮긴다. 설정이 켜져 있으면 마우스가 있는 모니터의 작업 영역 가장자리에 자석처럼 붙인다(snapToEdges).
 *  끄는 매 순간 계산하므로 붙고 떨어질 때 따로 움직이는 애니메이션 없이 손을 따라간다. displays는 끌기를 시작할 때 한 번 읽는다. */
function dragMove(win: BrowserWindow, x: number, y: number, size: { width: number; height: number }, pointer: { x: number; y: number }, displays: Electron.Display[]) {
  if (accountStore.getConfig().snapEdges !== false && displays.length) {
    const display = screen.getDisplayNearestPoint(pointer)
    const snapped = snapToEdges({ x: Math.round(x), y: Math.round(y), width: size.width, height: size.height }, display.workArea, display.bounds,
      displays.filter(d => d.id !== display.id).map(d => d.bounds))
    x = snapped.x; y = snapped.y
  }
  moveKeepingSize(win, x, y, size)
}

async function beginWindowInteraction(kind: string, pointerOrigin?: {x:number;y:number}, rendererDriven = false) {
  if (interacting || !widgetWindow || widgetWindow.isDestroyed() || !/^(move|resize-(n|s|e|w|ne|nw|se|sw))$/.test(kind)) return
  interacting = true
  const win = widgetWindow
  const startedDocked = accountStore.getConfig().placementMode === 'docked'
  let leftDockArea = !startedDocked
  refreshUsableRight()
  hidePopup(true)
  hideTip()
  // UIA 클라이언트(접근성 도구 등)가 켜진 PC에서는 활성 창의 접근성 트리를 주기적으로 읽어 UI 스레드가 50~70ms씩 멈춘다.
  // 끌기 위한 클릭으로 위젯이 활성화되면 그 멈춤이 이동 끊김으로 보이므로 제스처 동안 활성 상태를 내려놓는다.
  if (win.isFocused()) win.blur()
  let origin = pointerOrigin && Number.isFinite(pointerOrigin.x) && Number.isFinite(pointerOrigin.y)
    ? { x: Math.round(pointerOrigin.x), y: Math.round(pointerOrigin.y) } : screen.getCursorScreenPoint()
  try {
    const ghostWidth = dockWidth()
    // 집중 모드는 늘 카드 한 장으로 본다(창을 한 장 크기까지 줄일 수 있게).
    const shown = getAppState(), cardCount = shown.focus ? 1 : Math.max(1, visibleUsages(shown.usages, shown.accounts, shown.config).length), cardGap = Math.max(4, Math.min(16, shown.config.cardGap ?? 6))
    let start = win.getBounds()
    let last = origin
    let moved = false
    const displays = screen.getAllDisplays()

    // 작업표시줄 안 끌기: 도킹된 채로 좌우로만 움직이다가 위로 벗어나면 창으로 바뀐다.
    let mode: 'slide' | 'float' | 'converting' = startedDocked ? 'slide' : 'float'
    let slide: { grabDx: number; display: Electron.Display; top: number; width: number; offset: number } | null = null
    let slideBusy = false, slidePending: number | null = null
    if (startedDocked) {
      const r = await TaskbarDocker.getWidgetScreenRect(win)
      const display = screen.getDisplayNearestPoint(origin)
      const rect = r || { x: origin.x - 100, y: 0, width: currentWidgetWidth, height: 0 }
      slide = { grabDx: origin.x - rect.x, display, top: display.bounds.y + display.bounds.height - getTaskbarInfo(display).taskbarHeight, width: rect.width, offset: rect.x - display.bounds.x }
    } else if (kind === 'move' && dockSupported) showDockPreview(false, origin, true, ghostWidth)

    const slideTo = (offset: number) => {
      // 도킹은 수 ms~수십 ms 걸리므로 하나씩, 마지막 위치만 따라간다.
      slidePending = offset
      if (slideBusy) return
      slideBusy = true
      void (async () => {
        while (slidePending !== null && mode === 'slide') {
          const next = slidePending; slidePending = null
          await TaskbarDocker.slideDocked(win, next).catch(() => false)
        }
        slideBusy = false
      })()
    }
    const toFloat = async (p: {x:number;y:number}) => {
      mode = 'converting'
      while (slideBusy) await new Promise(r => setTimeout(r, 5))
      try { await setPlacement('floating') }
      catch (err) {
        // 떼어 내지 못하면 작업표시줄에 붙은 채로 남는다. 끌기는 계속 작업표시줄 안에서 하고, 멈춘 클릭·끌기 감시는 다시 붙여 되살린다.
        mode = 'slide'
        void updateWidgetBounds()
        throw err
      }
      const restored = win.getBounds()
      win.setBounds({ ...restored, x: Math.round(p.x - Math.min(restored.width / 2, 160)), y: Math.round(p.y - 24) })
      start = win.getBounds()
      origin = p
      leftDockArea = true
      mode = 'float'
    }

    const update = (p: { x: number; y: number }) => {
      if (win.isDestroyed()) return
      if (p.x === last.x && p.y === last.y && moved) return
      last = p
      const dx = p.x - origin.x, dy = p.y - origin.y
      moved ||= Math.abs(dx) + Math.abs(dy) > 5
      if (kind !== 'move') {
        const edge = kind.slice(7)
        let { x, y, width, height } = start
        if (edge.includes('e')) width = Math.max(MIN_WINDOW_SIZE.width, start.width + dx)
        if (edge.includes('w')) { width = Math.max(MIN_WINDOW_SIZE.width, start.width - dx); x = start.x + start.width - width }
        // 최소 높이는 지금 너비에서 보이는 카드가 모두 들어가는 높이(서비스가 하나면 카드 한 장 높이).
        const minH = Math.round(minWindowHeight(width / uiZoom(), cardCount, cardGap, !!accountStore.getConfig().hideHeader) * uiZoom())
        if (edge.includes('s')) height = Math.max(minH, start.height + dy)
        if (edge.includes('n')) { height = Math.max(minH, start.height - dy); y = start.y + start.height - height }
        if (!edge.includes('s') && !edge.includes('n')) height = Math.max(minH, height)
        win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
        return
      }
      if (mode === 'converting') return
      if (mode === 'slide' && slide) {
        if (p.y < slide.top - SLIDE_ESCAPE_PX) { void toFloat(p).catch(err => console.error('[Window] Undock during drag failed:', err)); return }
        const maxOffset = Math.max(0, dockRight(slide.display) - slide.display.bounds.x - slide.width)
        slide.offset = Math.round(Math.max(0, Math.min(maxOffset, p.x - slide.grabDx - slide.display.bounds.x)))
        slideTo(slide.offset)
        return
      }
      dragMove(win, start.x + dx, start.y + dy, start, p, displays)
      const display = screen.getDisplayNearestPoint(p)
      const target = dockSupported && isDockTarget(p, display.bounds, display.workArea)
      if (!target) leftDockArea = true
      showDockPreview(leftDockArea && target, p, false, ghostWidth)
    }
    const finish = async (p?: { x: number; y: number }) => {
      if (!interacting) return
      if (p && mode !== 'converting') update(p)
      interacting = false
      endInteraction = null
      interactionMove = null
      pointerProcess?.stop()
      pointerProcess = null
      while (mode === 'converting') await new Promise(r => setTimeout(r, 10))
      if (win.isDestroyed()) return
      if (mode === 'slide' && slide) {
        // 작업표시줄 안에서 놓으면 그 자리를 기억한다.
        while (slideBusy) await new Promise(r => setTimeout(r, 5))
        accountStore.saveConfig({ ...accountStore.getConfig(), alignment: 'left', offsetPx: slide.offset, verticalOffsetPx: 0 })
        broadcastState()
        return
      }
      const display = screen.getDisplayNearestPoint(last)
      const willDock = dockSupported && kind === 'move' && moved && leftDockArea && isDockTarget(last, display.bounds, display.workArea)
      if (willDock) {
        const { rect } = dockSlot(last, ghostWidth)
        const config = accountStore.getConfig()
        const safe = fitWindow(win.getBounds(), display.workArea)
        // setPlacement가 저장하는 마지막 자유 창 좌표는 끌기 전처럼 화면 안의 크기·위치로 남긴다.
        accountStore.saveConfig({ ...config, windowBounds: safe, alignment: 'left', offsetPx: rect.x - display.bounds.x, verticalOffsetPx: 0 })
        await animateIntoSlot(win, rect)
        // 반투명(layered) 상태로는 작업표시줄 자식이 되지 못하므로 도킹 전에 되돌린다. 그 순간 줄어든 창이 비치지 않게 잠깐 숨긴다
        // (자리는 그대로 두어 도킹할 모니터가 바뀌지 않게 하고, 도킹 명령이 다시 보이게 한다).
        win.hide()
        if (win.kind === 'backdrop') await TaskbarDocker.setAlpha(win, null)
        else win.setOpacity(1)
        await setPlacement('docked', safe)
        // 숨겼던 창을 보조 프로그램이 도킹하며 다시 보이게 했지만 Electron은 여전히 숨김으로 알아 새 프레임을 그리지 않는다
        // (실측: 도킹 모양 대신 줄어든 대시보드가 멈춰 보임). 보임을 알리면 Electron이 자기 좌표로 창을 옮기므로 곧바로 다시 붙인다.
        if (!win.isDestroyed()) { win.showInactive(); await updateWidgetBounds() }
        showDockPreview(false)
      } else {
        showDockPreview(false)
        // 옮기기만 했으면 끄는 동안 반올림으로 1~2px 흔들린 크기를 저장하지 않고 처음 크기로 돌려 둔다.
        const now = win.getBounds()
        const bounds = fitWindow(kind === 'move' ? { ...now, width: start.width, height: start.height } : now, display.workArea)
        win.setBounds(bounds)
        accountStore.saveConfig({ ...accountStore.getConfig(), windowBounds: bounds })
        rememberLayout()
        // 끄는 동안 내려놓았던 키보드 포커스를 돌려준다(제목줄을 누른 뒤 숫자키·Esc가 다른 창으로 가지 않게).
        if (!win.isDestroyed() && !accountStore.getConfig().clickThrough) win.focus()
      }
    }
    endInteraction = finish
    // 렌더러가 좌표를 보내는 자유 창 제스처도 보조 프로그램의 실제 커서 좌표·버튼 놓음을 함께 받는다.
    // 커서가 작업표시줄 위로 들어가면 렌더러는 이동을 더 받지 못해(실측) 도킹 미리보기가 뜨지 않는 일이 있었다.
    if (rendererDriven && !startedDocked) interactionMove = update
    pointerProcess = TaskbarDocker.watchPointer(update, p => { void finish(p).catch(console.error) })
  } catch (err) {
    interacting = false
    interactionMove = null
    showDockPreview(false)
    console.error('[Window] Interaction failed:', err)
  }
}

async function positionPopupWindow() {
  if (!popupWindow || popupWindow.isDestroyed()) return
  const config = accountStore.getConfig()

  let widgetX: number
  let widgetY: number
  let widgetW: number

  if (widgetWindow && !widgetWindow.isDestroyed()) {
    if (config.placementMode !== 'floating') {
      // docked 모드에서는 widgetWindow.getBounds()가 taskbar client 상대좌표이므로
      // TaskbarDock.exe getscreenrect로 화면 절대 좌표를 정확히 획득
      const screenRect = await TaskbarDocker.getWidgetScreenRect(widgetWindow)
      if (screenRect) {
        widgetX = screenRect.x
        widgetY = screenRect.y
        widgetW = screenRect.width
      } else {
        const bounds = widgetWindow.getBounds()
        widgetX = bounds.x
        widgetY = bounds.y
        widgetW = bounds.width
      }
    } else {
      const bounds = widgetWindow.getBounds()
      widgetX = bounds.x
      widgetY = bounds.y
      widgetW = bounds.width
    }
  } else {
    const pos = calculateWidgetPosition(config, currentWidgetWidth, currentWidgetHeight)
    widgetX = pos.x
    widgetY = pos.y
    widgetW = currentWidgetWidth
  }

  const saved = config.popupBounds
  if (saved) {
    const area = screen.getDisplayMatching(saved).workArea
    popupPlacing = true
    popupWindow.setBounds(fitWindow({ ...saved, width: Math.min(saved.width, area.width), height: Math.min(saved.height, area.height) }, area))
    popupPlacing = false
    return
  }
  const popupPos = calculatePopupPosition(widgetX, widgetW, Math.round(POPUP_WIDTH * uiZoom()), Math.round(POPUP_HEIGHT * uiZoom()), widgetY)

  popupPlacing = true
  popupWindow.setBounds({
    x: popupPos.x,
    y: popupPos.y,
    width: Math.round(POPUP_WIDTH * uiZoom()),
    height: Math.round(POPUP_HEIGHT * uiZoom())
  })
  popupPlacing = false
}

/** 팝업을 옮기거나 키우면 그 위치·크기를 기억한다(앱이 자리를 잡는 동안의 변경은 빼고). */
let popupPlacing = false
let popupSaveTimer: ReturnType<typeof setTimeout> | undefined
function savePopupBounds(b: Electron.Rectangle) {
  clearTimeout(popupSaveTimer)
  popupSaveTimer = setTimeout(() => accountStore.saveConfig({ ...accountStore.getConfig(), popupBounds: { x: b.x, y: b.y, width: b.width, height: b.height } }), 300)
}

/** 팝업 창 옮기기·크기 바꾸기. 위젯 창과 같은 제스처(렌더러가 좌표를 보냄)이고, 작업표시줄 도킹만 없다. */
function beginPopupInteraction(kind: string, pointerOrigin?: {x:number;y:number}) {
  if (interacting || !popupWindow || popupWindow.isDestroyed() || !/^(move|resize-(n|s|e|w|ne|nw|se|sw))$/.test(kind)) return
  interacting = true
  const win = popupWindow
  cancelHidePopup()
  hideTip()
  const origin = pointerOrigin && Number.isFinite(pointerOrigin.x) && Number.isFinite(pointerOrigin.y)
    ? { x: Math.round(pointerOrigin.x), y: Math.round(pointerOrigin.y) } : screen.getCursorScreenPoint()
  const shown = getAppState(), cardCount = shown.focus ? 1 : Math.max(1, visibleUsages(shown.usages, shown.accounts, shown.config).length), cardGap = Math.max(4, Math.min(16, shown.config.cardGap ?? 6))
  const start = win.getBounds()
  let last = origin
  const displays = screen.getAllDisplays()
  const update = (p: { x: number; y: number }) => {
    if (win.isDestroyed()) return
    last = p
    const dx = p.x - origin.x, dy = p.y - origin.y
    if (kind === 'move') { dragMove(win, start.x + dx, start.y + dy, start, p, displays); return }
    const edge = kind.slice(7)
    let { x, y, width, height } = start
    if (edge.includes('e')) width = Math.max(MIN_WINDOW_SIZE.width, start.width + dx)
    if (edge.includes('w')) { width = Math.max(MIN_WINDOW_SIZE.width, start.width - dx); x = start.x + start.width - width }
    const minH = Math.round(minWindowHeight(width / uiZoom(), cardCount, cardGap, !!accountStore.getConfig().hideHeader) * uiZoom())
    if (edge.includes('s')) height = Math.max(minH, start.height + dy)
    if (edge.includes('n')) { height = Math.max(minH, start.height - dy); y = start.y + start.height - height }
    if (!edge.includes('s') && !edge.includes('n')) height = Math.max(minH, height)
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
  }
  interactionMove = update
  endInteraction = async (p?: { x: number; y: number }) => {
    if (!interacting) return
    if (p) update(p)
    interacting = false
    endInteraction = null
    interactionMove = null
    if (win.isDestroyed()) return
    const now = win.getBounds()
    const bounds = fitWindow(kind === 'move' ? { ...now, width: start.width, height: start.height } : now, screen.getDisplayNearestPoint(last).workArea)
    win.setBounds(bounds)
    savePopupBounds(bounds)
  }
}

function createPopupWindow() {
  const config = accountStore.getConfig()
  const widgetPos = calculateWidgetPosition(config, currentWidgetWidth, currentWidgetHeight)
  const actualWidgetY = (widgetWindow && !widgetWindow.isDestroyed()) ? widgetWindow.getBounds().y : widgetPos.y
  const popupPos = calculatePopupPosition(widgetPos.x, currentWidgetWidth, POPUP_WIDTH, POPUP_HEIGHT, actualWidgetY)

  const win = popupWindow = new SurfaceWindow({
    x: popupPos.x,
    y: popupPos.y,
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false, // 크기는 화면 안 손잡이로 바꾼다(투명 창은 Windows 기본 가장자리 끌기가 안 됨)
    show: false,
    title: 'AI 사용량 · 상세',
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true
    }
  }, currentSurfaceKind())
  keepZoom(win)
  popupWindow.on('page-title-updated', event => event.preventDefault())
  popupWindow.on('resize',()=>{if(popupWindow)applyWindowShape(popupWindow,'native')})
  popupWindow.on('moved', () => { if (popupWindow === win && !popupPlacing && win.isVisible()) savePopupBounds(win.getBounds()) })

  popupWindow.setAlwaysOnTop(true, 'screen-saver', 9999)

  if (process.env.VITE_DEV_SERVER_URL) {
    popupWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#view=popup`)
  } else {
    popupWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'view=popup', query: { view: 'popup' } })
  }

  popupWindow.on('blur', () => {
    if (!isPopupLocked) {
      scheduleHidePopup(600)
    }
  })

  popupWindow.on('closed', () => {
    if (popupWindow === win) popupWindow = null
  })
}

async function showPopup(focus = false, lock = false) {
  cancelHidePopup()
  if (lock) {
    isPopupLocked = true
  }

  if (!popupWindow || popupWindow.isDestroyed()) {
    createPopupWindow()
  }
  if (!popupWindow) return
  const isAlreadyVisible = popupWindow.isVisible()

  if (!isAlreadyVisible) {
    // 팝업이 닫혀 있다가 새로 열릴 때만 위젯의 현재 위치를 기준으로 좌표를 결정하여 띄움 (뜬 후에는 자리 고정)
    await positionPopupWindow()

    // 숨긴 창을 다시 show하면 숨기기 직전의 마지막 프레임(완전히 열린 팝업)이 잠깐 보인 뒤
    // 등장 애니메이션이 처음부터 재생되어 두 번 열리는 것처럼 보임. 투명하게 띄워두고
    // 렌더러가 애니메이션 첫 프레임을 그렸다고 알려오면(POPUP_READY) 불투명으로 전환한다.
    // 아크릴 창은 setOpacity를 쓰면 layered 창으로 남아 흐림이 사라지므로 보조 프로그램으로 가렸다가 되돌린다.
    const win = popupWindow
    if (win.kind !== 'backdrop' || !await TaskbarDocker.setFaded(win, true)) win.setOpacity(0)
    if (popupWindow !== win || win.isDestroyed()) return
    if (popupRevealTimer) clearTimeout(popupRevealTimer)
    popupRevealTimer = setTimeout(revealPopup, 300) // 렌더러 응답이 없어도 팝업이 안 보이는 일은 없도록

    if (focus) {
      popupWindow.show()
      popupWindow.moveTop() // 다른 '항상 위' 창보다도 앞으로
      popupWindow.focus()
    } else {
      popupWindow.showInactive()
    }
    popupWindow.webContents.send(IPC_CHANNELS.POPUP_OPENED, getAppState())
  } else if (focus) {
    popupWindow.moveTop()
    popupWindow.focus()
  }
}

function revealPopup() {
  if (popupRevealTimer) {
    clearTimeout(popupRevealTimer)
    popupRevealTimer = null
  }
  if (popupWindow && !popupWindow.isDestroyed()) {
    if (popupWindow.getOpacity() < 1) popupWindow.setOpacity(1)
    if (popupWindow.kind === 'backdrop') { const win = popupWindow; void TaskbarDocker.setFaded(win, false).then(() => win.keepBackdrop()) }
  }
}

function scheduleHidePopup(delayMs = 400) {
  if (isPopupLocked) {
    return
  }
  cancelHidePopup()
  popupHideTimer = setTimeout(() => {
    if (!isPopupLocked) {
      hidePopup(true)
    }
    popupHideTimer = null
  }, delayMs)
}

function cancelHidePopup() {
  if (popupHideTimer) {
    clearTimeout(popupHideTimer)
    popupHideTimer = null
  }
}

function hidePopup(force = false) {
  if (!force && isPopupLocked) {
    return
  }
  isPopupLocked = false
  cancelHidePopup()
  if (popupWindow && !popupWindow.isDestroyed() && popupWindow.isVisible()) {
    // 카드 위에 마우스를 둔 채 닫으면(Esc·닫기) 렌더러가 마우스가 떠난 것을 알 수 없어 설명 창이 남는다.
    hideTip()
    popupWindow.hide()
    syncDialogTopmost() // 위젯 때문에 올려 둔 정보 창을 원래대로
  }
}

// 도킹 모드 위젯 클릭: 네이티브 워처가 물리 클릭마다 CLICK 한 줄을 보낸다.
// 한 번 누르면 상세 팝업, 두 번 누르면 도킹을 유지한 채 그 카드의 집중 모드를 켜고 끈다.
// 두 번째 클릭을 기다리는 동안(400ms) 팝업을 미룬다.
function handleDockedWidgetClick() {
  const now = Date.now(), point = screen.getCursorScreenPoint()
  if (lastDockedWidgetClickAt > 0 && now - lastDockedWidgetClickAt <= DOUBLE_CLICK_WINDOW_MS) {
    lastDockedWidgetClickAt = 0
    clearTimeout(dockClickTimer)
    void toggleDockedFocus(point)
    return
  }
  lastDockedWidgetClickAt = now
  clearTimeout(dockClickTimer)
  dockClickTimer = setTimeout(() => { lastDockedWidgetClickAt = 0; void togglePopup() }, DOUBLE_CLICK_WINDOW_MS)
}

/** 도킹 화면에서 두 번 누른 자리의 카드로 집중 모드를 켠다. 이미 켜져 있으면 끈다(카드가 한 장뿐이므로). */
async function toggleDockedFocus(point: Electron.Point) {
  if (focusId) { setFocus(null); return }
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  const b = widgetWindow.getBounds()
  const x = Math.round(point.x - b.x), y = Math.round(point.y - b.y)
  try {
    const id = await widgetWindow.webContents.executeJavaScript(`(() => { const el = document.elementFromPoint(${x}, ${y}); return el?.closest('[data-account-id]')?.dataset.accountId || null })()`)
    if (typeof id === 'string' && id) setFocus(id)
  } catch (err) { console.warn('[Main] 도킹 집중 모드 대상 확인 실패', err) }
}

async function togglePopup() {
  cancelHidePopup()
  if (popupWindow && popupWindow.isVisible()) {
    hidePopup(true)
  } else {
    await showPopup(true, true) // 클릭으로 열 때는 닫기 버튼 누를 때까지 락 유지
  }
}

function getTrayIconImage(): Electron.NativeImage {
  const candidates = [
    path.join(__dirname, '../public/tray-icon.ico'),
    path.join(__dirname, '../public/tray-icon.png'),
    path.join(app.getAppPath(), 'public/tray-icon.ico'),
    path.join(app.getAppPath(), 'public/tray-icon.png'),
    path.join(process.resourcesPath, 'public/tray-icon.ico'),
    path.join(process.resourcesPath, 'public/tray-icon.png')
  ]

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) return img
    }
  }

  // fallback
  return nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA9SURBVDhPY/wPBAwUACZSDaBkwzCgZANiDGDFyAbA5EkaBt0AYgwkGQwDYAYzEaMZZQZgBmgwA9F/IGAAAGXvCflG0g+xAAAAAElFTkSuQmCC',
      'base64'
    )
  )
}

/** Linux 자동 시작: ~/.config/autostart의 .desktop 파일(XDG 표준). AppImage면 그 파일 경로로 실행한다. */
const linuxAutostartFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'ai-usage-widget.desktop')
function applyLinuxAutoLaunch(enable: boolean) {
  const file = linuxAutostartFile()
  if (!enable || !app.isPackaged) { fs.rmSync(file, { force: true }); return }
  const exec = process.env.APPIMAGE || process.execPath
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, ['[Desktop Entry]', 'Type=Application', 'Name=AI Usage Widget', `Exec="${exec.replace(/"/g, '\\"')}" --hidden`, 'X-GNOME-Autostart-enabled=true', 'NoDisplay=false', ''].join('\n'))
}

/** Windows 시작 프로그램에 등록할 명령. Electron은 경로를 따옴표 없이 그대로 쓰므로(Electron 34, CVE-2026-34768) 직접 감싼다.
 *  감싸지 않으면 경로의 공백('AI Usage Widget.exe')에서 끊겨 로그인할 때 앱이 시작되지 않았다.
 *  등록 여부를 읽을 때도 같은 값으로 비교해야 한다(Electron은 등록값과 이 명령이 정확히 같은지 본다). */
const windowsLoginItem = () => ({ path: `"${process.execPath}"`, args: ['--hidden'] })

function applyAutoLaunch(enable: boolean) {
  if (isPreview) return
  if (process.platform === 'linux') {
    try { applyLinuxAutoLaunch(enable) } catch (err) { console.warn('[Main] 자동 시작 파일을 쓰지 못했습니다:', err) }
    updateTrayMenu()
    return
  }
  try {
    if (!app.isPackaged) {
      // 개발 모드에서는 node_modules/electron/dist/electron.exe가 인자 없이 시작프로그램에 등록되어
      // 부팅 시 기본 Electron 환영 창이 뜨는 현상을 방지하기 위해 등록을 해제합니다.
      app.setLoginItemSettings({
        openAtLogin: false,
        path: process.execPath
      })
      updateTrayMenu()
      return
    }

    app.setLoginItemSettings({ openAtLogin: enable, ...windowsLoginItem() })
    updateTrayMenu()
  } catch (err) {
    console.warn('[Main] Failed to setLoginItemSettings:', err)
  }
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  const config = accountStore.getConfig()
  const isAutoStart = process.platform === 'linux' ? fs.existsSync(linuxAutostartFile())
    : app.isPackaged
    ? (app.getLoginItemSettings(windowsLoginItem()).openAtLogin ?? config.openAtLogin ?? true)
    : (config.openAtLogin ?? false)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: t('trayToggleWidget'),
      click: () => { void toggleWidgetVisibility() }
    },
    {
      label: `클릭 통과 잠금${config.shortcuts?.lock ? ` (${config.shortcuts.lock})` : ''}`,
      type: 'checkbox',
      checked: !!config.clickThrough,
      enabled: config.placementMode !== 'docked',
      click: (item) => setClickThrough(item.checked)
    },
    ...(dockSupported ? [{
      label: t('trayOpenPopup'),
      click: () => {
        showPopup(true, true)
      }
    }] : []),
    {
      label: '설정',
      click: () => openSettingsWindow('last')
    },
    { label: '사용량 통계', click: () => openStatsWindow() },
    { label: '정보·업데이트', click: () => openAboutWindow() },
    { type: 'separator' },
    {
      label: t('trayAutoLaunch'),
      type: 'checkbox',
      checked: isAutoStart,
      click: (item) => {
        const nextConfig = { ...accountStore.getConfig(), openAtLogin: item.checked }
        accountStore.saveConfig(nextConfig)
        applyAutoLaunch(item.checked)
        broadcastState()
      }
    },
    {
      label: t('trayRefreshNow'),
      click: () => {
        quotaManager.refreshAll().then(() => broadcastState())
      }
    },
    // 설치판에서만: 새 버전이 받아져 있으면 바로 설치, 아니면 확인
    ...(updater?.state.status === 'ready' ? [{ label: `새 버전 ${updater.state.version} 설치하고 다시 시작`, click: () => { updater?.install() } }] : []),
    { type: 'separator' },
    {
      label: t('trayQuit'),
      click: () => {
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
}

function createTray() {
  const iconCanvas = getTrayIconImage()
  tray = new Tray(iconCanvas)
  tray.setToolTip(t('trayTooltip'))

  updateTrayMenu()

  // Linux(AppIndicator)는 대부분 왼쪽 클릭을 메뉴로 보내지만, 클릭이 오는 환경에서는 위젯을 보이고 숨긴다.
  // Windows는 더블 클릭을 클릭 두 번으로도 보낸다. 바로 이어진 두 번째 클릭은 무시해 위젯이 열렸다 곧바로 닫히지 않게 한다.
  let lastTrayClick = 0
  tray.on('click', () => {
    const now = Date.now()
    if (now - lastTrayClick < 500) return
    lastTrayClick = now
    // 트레이로 숨겼으면 다시 보인다. 창 모드는 창을, 독 모드는 위젯을 연다.
    if (widgetManuallyHidden || !dockSupported || accountStore.getConfig().placementMode !== 'docked') void showWidgetWindow()
    else void togglePopup()
  })
}

function setupIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.GET_STATE, () => {
    return getAppState()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_CONFIG, async (_event, rawPatch: unknown) => {
    const patch = sanitizeConfigPatch(rawPatch)
    const prevConfig = accountStore.getConfig()
    // 스케일을 바꾸면 창 크기도 같은 비율로 바꿔 창 안의 배치가 그대로인 채 균일하게 커지고 작아지게 한다.
    if (patch.fontScale !== undefined) {
      const ratio = patch.fontScale / (prevConfig.fontScale || 100)
      setTimeout(() => { if (Math.abs(ratio - 1) > .001) rescaleWindows(ratio); applyZoom() }, 0)
    }
    // 배치 전환은 네이티브 부모 창 변경과 함께 수행한다. 일반 디자인 변경은 창 위치를 건드리지 않는다.
    const requestedMode = patch.placementMode
    const nextConfig: WidgetConfig = { ...prevConfig, ...patch, placementMode: prevConfig.placementMode }
    accountStore.saveConfig(nextConfig)

    if (patch.doubleClickToOpenPopup !== undefined) {
      lastDockedWidgetClickAt = 0
    }

    // 윈도우 시작 시 실행 설정 변경 시 적용
    if (patch.openAtLogin !== undefined && prevConfig.openAtLogin !== nextConfig.openAtLogin) {
      applyAutoLaunch(Boolean(nextConfig.openAtLogin))
    }

    // 갱신 주기 변경 시 폴링 인터벌 동적 재적용
    if (patch.autoUpdate !== undefined || patch.updateHour !== undefined) updater?.schedule(nextConfig.autoUpdate !== false, nextConfig.updateHour ?? 3)
    if (patch.refreshIntervalSec !== undefined && prevConfig.refreshIntervalSec !== nextConfig.refreshIntervalSec) {
      if (!isPreview) quotaManager.startPolling(nextConfig.refreshIntervalSec, false)
    }

    // 모드 전환 감지 (docked <-> floating)
    if (requestedMode && requestedMode !== prevConfig.placementMode) await setPlacement(requestedMode)
    else if (nextConfig.placementMode === 'docked' && ['offsetPx', 'alignment', 'verticalOffsetPx'].some(k => k in patch)) await updateWidgetBounds()
    if (patch.alwaysOnTop !== undefined) applyWindowTopmost(accountStore.getConfig())
    // 제목줄을 다시 보이면 카드가 다 들어가도록 창 높이를 늘린다
    if (patch.hideHeader === false && nextConfig.placementMode === 'floating' && !focusId) growToFitCards()
    if (patch.appearance !== undefined || patch.useAcrylic !== undefined || patch.opacity !== undefined) applySurface()
    if (patch.clickThrough !== undefined) { applyClickThrough(); updateTrayMenu() }
    if (patch.design !== undefined || patch.rememberPerMonitor === true) rememberLayout()
    if (patch.shortcuts !== undefined) { registerShortcuts(); updateTrayMenu() }
    if (patch.webEnabled !== undefined || patch.webRemote !== undefined || patch.webPort !== undefined) applyWeb()
    // [불변 원칙]: 팝업창은 최초 등장 시점에만 위젯 위치 기준으로 좌표를 설정합니다.
    // 사용자가 팝업창을 열고 조작(슬라이더 등)하는 동안에는 팝업 위치가 이동하면 안 되므로
    // 설정 변경(UPDATE_CONFIG) 시 positionPopupWindow()를 절대 호출하지 않습니다.
    broadcastState()
    return getAppState()
  })

  ipcMain.handle(IPC_CHANNELS.REFRESH_QUOTA, async () => {
    if (isPreview) { broadcastState(); return getAppState() }
    const refresh = quotaManager.refreshAll()
    broadcastState()
    await refresh
    broadcastState()
    return getAppState()
  })

  ipcMain.handle(IPC_CHANNELS.ADD_CUSTOM_ACCOUNT, (_event, acc: Partial<AccountConfig>) => {
    // 직접 입력 계정: id는 항상 새로 만들고(기존 계정과 겹치지 않게) 숫자는 0~100으로 맞춘다.
    const pct = (v: unknown, d: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : d
    const text = (v: unknown, d: string, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d
    const m = acc?.customMock
    const newAcc: AccountConfig = {
      id: `custom-${Date.now()}`,
      name: text(acc?.name, '직접 입력', 60),
      provider: 'custom',
      enabled: true,
      customMock: m ? {
        primaryPercent: pct(m.primaryPercent, 50),
        primaryReset: text(m.primaryReset, '', 20),
        weeklyPercent: pct(m.weeklyPercent, 30),
        weeklyReset: text(m.weeklyReset, '', 20),
        iconLetter: text(m.iconLetter, 'C', 2).toUpperCase(),
        brandColor: /^#[\da-f]{6}$/i.test(m.brandColor || '') ? m.brandColor! : '#3B82F6'
      } : {
        primaryPercent: 50,
        primaryReset: '2h 30m',
        weeklyPercent: 30,
        weeklyReset: '4d 12h',
        iconLetter: (acc.name || 'C').charAt(0).toUpperCase(),
        brandColor: '#3B82F6'
      }
    }
    accountStore.addAccount(newAcc)
    broadcastState()
    if (!isPreview) quotaManager.refreshAll().finally(() => broadcastState())
    return getAppState()
  })

  ipcMain.handle(IPC_CHANNELS.RESTORE_DETECTED_APP, (_event, appData: any) => {
    accountStore.restoreDetectedAccount(appData)
    broadcastState()
    if (!isPreview) quotaManager.refreshAll().finally(() => broadcastState())
    return getAppState()
  })

  ipcMain.handle(IPC_CHANNELS.RESET_DEFAULT_ACCOUNTS, () => {
    accountStore.resetToDefaultAccounts()
    broadcastState()
    if (!isPreview) quotaManager.refreshAll().finally(() => broadcastState())
    return getAppState()
  })

  ipcMain.handle(IPC_CHANNELS.TOGGLE_ACCOUNT, (_event, id: string, enabled: boolean) => {
    accountStore.toggleAccount(id, enabled)
    broadcastState()
    if (!isPreview) quotaManager.refreshAll().finally(() => broadcastState())
    return getAppState()
  })

  ipcMain.handle(IPC_CHANNELS.REMOVE_ACCOUNT, (_event, id: string) => {
    accountStore.removeAccount(id)
    broadcastState()
    return getAppState()
  })

  ipcMain.handle(IPC_CHANNELS.REORDER_ACCOUNT, (_event, id: string, direction: 'up' | 'down') => {
    accountStore.reorderAccount(id, direction)
    broadcastState()
    return getAppState()
  })

  ipcMain.handle(IPC_CHANNELS.MOVE_ACCOUNT, (_event, id: string, beforeId: string | null) => {
    accountStore.moveAccount(id, beforeId)
    broadcastState()
    return getAppState()
  })
  ipcMain.handle(IPC_CHANNELS.RENAME_ACCOUNT, (_event, id: string, name: string) => {
    accountStore.renameAccount(String(id), String(name))
    broadcastState()
    return getAppState()
  })
  // 계정 표시 설정(모델 전용 한도 보기·작업표시줄에서만 숨김). 정해진 키만 받는다.
  // 사용 설명서 PDF: 설치본은 실행 파일 옆 '사용 설명서.pdf', 개발 중에는 프로젝트의 docs/user-guide.pdf.
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => { await updater?.check(true); return getAppState() })
  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => updater?.install() ?? false)
  ipcMain.handle(IPC_CHANNELS.OPEN_GUIDE, async () => {
    const file = guidePath()
    if (!file) return false
    return (await shell.openPath(file)) === ''
  })
  ipcMain.handle(IPC_CHANNELS.ACCOUNT_DISPLAY, (_event, id: string, patch: { showScoped?: unknown; hiddenInDock?: unknown; barColor?: unknown; launchCli?: unknown; launchApp?: unknown; launchCwd?: unknown }) => {
    const clean: { showScoped?: boolean; hiddenInDock?: boolean; barColor?: string; launchCli?: string; launchApp?: string; launchCwd?: string } = {}
    // 직접 지정한 실행 대상: 있는 파일의 절대 경로만, 빈 값이면 자동으로 되돌린다.
    for (const k of ['launchCli', 'launchApp'] as const) {
      const v = patch?.[k]
      if (v === '') clean[k] = undefined
      else if (typeof v === 'string' && path.isAbsolute(v) && fs.existsSync(v)) clean[k] = v
    }
    // CLI 시작 폴더: 있는 폴더만, 빈 값이면 홈 폴더로
    if (patch?.launchCwd === '') clean.launchCwd = undefined
    else if (typeof patch?.launchCwd === 'string' && path.isAbsolute(patch.launchCwd) && fs.existsSync(patch.launchCwd) && fs.statSync(patch.launchCwd).isDirectory()) clean.launchCwd = patch.launchCwd
    if (typeof patch?.showScoped === 'boolean') clean.showScoped = patch.showScoped
    if (typeof patch?.hiddenInDock === 'boolean') clean.hiddenInDock = patch.hiddenInDock
    // 평소 색: 'brand'(서비스 색으로 되돌림)·'green'·'#rrggbb'만 받는다.
    if (patch?.barColor === 'brand') clean.barColor = undefined
    else if (typeof patch?.barColor === 'string' && ownColor(patch.barColor)) clean.barColor = patch.barColor
    accountStore.patchAccountDisplay(String(id), clean)
    broadcastState()
    if (clean.hiddenInDock !== undefined && accountStore.getConfig().placementMode === 'docked') void updateWidgetBounds()
    return getAppState()
  })
  ipcMain.handle(IPC_CHANNELS.HIDE_ACCOUNT, (_event, id: string, hidden: boolean) => {
    accountStore.hideAccount(id, hidden)
    broadcastState()
    return getAppState()
  })
  ipcMain.handle(IPC_CHANNELS.BEGIN_INTERACTION, (event, kind: string, origin?: {x:number;y:number}) =>
    popupWindow && !popupWindow.isDestroyed() && event.sender === popupWindow.webContents ? beginPopupInteraction(kind, origin) : beginWindowInteraction(kind, origin, true))
  // 밀린 좌표는 마지막 것만 적용한다(창 이동 호출이 수 ms 걸려 큐가 쌓이는 것을 막음).
  let pendingMove: {x:number;y:number} | null = null
  ipcMain.on(IPC_CHANNELS.MOVE_INTERACTION, (_event, p?: {x:number;y:number}) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return
    const scheduled = pendingMove !== null
    pendingMove = { x: Math.round(p.x), y: Math.round(p.y) }
    if (!scheduled) setImmediate(() => { const next = pendingMove; pendingMove = null; if (next) interactionMove?.(next) })
  })
  ipcMain.handle(IPC_CHANNELS.END_INTERACTION, (_event, point?: {x:number;y:number}) => endInteraction?.(point))
  ipcMain.handle(IPC_CHANNELS.HIDE_WIDGET, () => {
    widgetManuallyHidden = true
    hideTip()
    widgetWindow?.hide()
    hidePopup(true)
  })

  ipcMain.handle(IPC_CHANNELS.HIDE_POPUP, () => {
    hidePopup(true)
  })

  ipcMain.handle(IPC_CHANNELS.UNLOCK_POPUP, () => {
    isPopupLocked = false
  })

  ipcMain.handle(IPC_CHANNELS.RESIZE_WIDGET, async (_event, width: number, height: number) => {
    if (accountStore.getConfig().placementMode !== 'docked') return
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const w = Math.max(80, Math.min(screen.getPrimaryDisplay().bounds.width, Math.round(width))), h = Math.min(44, Math.round(height))
      // 같은 크기면 다시 도킹하지 않는다(도킹 직후 렌더러가 같은 크기를 알려 오는 경우).
      if (w === currentWidgetWidth && h === currentWidgetHeight) return
      currentWidgetWidth = w
      currentWidgetHeight = h
      await updateWidgetBounds()
    }
  })

  ipcMain.handle(IPC_CHANNELS.TEST_NOTIFICATION, () => notifier?.test() ?? false)
  ipcMain.on(IPC_CHANNELS.TIP_SHOW, (event, text: string, rect) => { void showTip(event.sender, String(text), rect).catch(() => {}) })
  ipcMain.on(IPC_CHANNELS.TIP_HIDE, () => hideTip())
  ipcMain.on(IPC_CHANNELS.WINDOW_CONTROL, (event, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || (win !== settingsWindow && win !== aboutWindow && win !== statsWindow)) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize() }
    else if (action === 'close') win.close()
  })
  // 위젯 화면이 그린 트레이 아이콘(가장 빠듯한 남은 %). null이면 기본 아이콘으로 되돌린다.
  ipcMain.on(IPC_CHANNELS.SET_TRAY_IMAGE, (event, dataUrl: string | null, tooltip: string) => {
    if (!tray || tray.isDestroyed() || event.sender !== widgetWindow?.webContents) return
    const image = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,') ? nativeImage.createFromDataURL(dataUrl) : null
    tray.setImage(image && !image.isEmpty() ? image : getTrayIconImage())
    tray.setToolTip(typeof tooltip === 'string' && tooltip ? tooltip.slice(0, 120) : t('trayTooltip'))
  })
  ipcMain.handle(IPC_CHANNELS.GET_HISTORY, (_event, id: string, from: number, to: number, max: number) =>
    history?.range(String(id), Number(from) || 0, Number(to) || Date.now(), Math.max(10, Math.min(500, Number(max) || 200))) ?? [])
  ipcMain.handle(IPC_CHANNELS.OPEN_SETTINGS, (_event, tab?: SettingsTab) => {
    openSettingsWindow(tab || 'design')
  })
  // 설정 백업·복원: 화면·알림 설정과 카드 목록만(로그인 정보는 앱이 갖고 있지 않다). 불러올 때도 같은 검사를 거친다.
  ipcMain.handle(IPC_CHANNELS.EXPORT_SETTINGS, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || undefined
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const r = await dialog.showSaveDialog(win!, { title: '설정 내보내기', defaultPath: `ai-usage-settings-${stamp}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return { ok: false }
    const { windowBounds: _w, layoutsByMonitor: _l, claudeOrgsSeen: _c, grokOffered: _g, uiVersion: _u, webPasswordHash: _p, ...config } = accountStore.getConfig()
    fs.writeFileSync(r.filePath, JSON.stringify({ app: 'ai-usage-widget', version: app.getVersion(), exportedAt: new Date().toISOString(), config, accounts: accountStore.getAccounts() }, null, 2), 'utf-8')
    return { ok: true, message: '설정을 파일로 내보냈어요.' }
  })
  ipcMain.handle(IPC_CHANNELS.IMPORT_SETTINGS, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || undefined
    const r = await dialog.showOpenDialog(win!, { title: '설정 불러오기', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePaths[0]) return { ok: false }
    let data: any
    try { data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf-8')) } catch { return { ok: false, message: '읽을 수 없는 파일이에요.' } }
    if (data?.app !== 'ai-usage-widget' || typeof data.config !== 'object') return { ok: false, message: '이 앱에서 내보낸 설정 파일이 아니에요.' }
    const accounts = Array.isArray(data.accounts) ? data.accounts.filter((a: any) => a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.provider === 'string')
      .map((a: any) => ({ id: a.id.slice(0, 120), name: a.name.slice(0, 80), provider: a.provider, enabled: a.enabled !== false, ...(typeof a.orgUuid === 'string' ? { orgUuid: a.orgUuid } : {}), ...(typeof a.homeDir === 'string' ? { homeDir: a.homeDir } : {}),
        ...(a.hidden === true ? { hidden: true } : {}), ...(a.hiddenInDock === true ? { hiddenInDock: true } : {}), ...(a.showScoped === false ? { showScoped: false } : {}), ...(ownColor(a.barColor) ? { barColor: a.barColor } : {}),
        ...(a.customMock && typeof a.customMock === 'object' ? { customMock: a.customMock } : {}), ...(a.isLocalIde === true ? { isLocalIde: true } : {}) })) : []
    const ok = await dialog.showMessageBox(win!, { type: 'question', buttons: ['불러오기', '취소'], defaultId: 0, cancelId: 1, title: '설정 불러오기',
      message: '이 파일의 설정으로 바꿀까요?', detail: `${data.exportedAt ? new Date(data.exportedAt).toLocaleString('ko-KR') + '에 ' : ''}내보낸 설정${accounts.length ? `과 카드 ${accounts.length}개` : ''}로 지금 설정을 바꿔요.` })
    if (ok.response !== 0) return { ok: false }
    const prev = accountStore.getConfig()
    const next = { ...prev, ...sanitizeConfigPatch(data.config), placementMode: prev.placementMode }
    accountStore.saveConfig(next)
    if (accounts.length) accountStore.saveAccounts(accounts as AccountConfig[])
    if (prev.openAtLogin !== next.openAtLogin) applyAutoLaunch(Boolean(next.openAtLogin))
    registerShortcuts(); applySurface(); applyWindowTopmost(next); updateTrayMenu(); broadcastState()
    if (!isPreview) void quotaManager.refreshAll().then(() => broadcastState())
    return { ok: true, message: '설정을 불러왔어요.' }
  })
  ipcMain.handle(IPC_CHANNELS.OPEN_ABOUT, () => openAboutWindow())
  ipcMain.handle(IPC_CHANNELS.OPEN_STATS, (_event, id: unknown) => openStatsWindow(typeof id === 'string' ? id : undefined))
  ipcMain.handle(IPC_CHANNELS.GET_DAILY, () => history?.daily() ?? {})
  // API 요금 환산: 새로 덧붙은 기록을 읽기 시작하고(백그라운드) 지금까지의 집계를 바로 돌려준다. 통계 창이 읽는 중이면 다시 묻는다.
  ipcMain.handle(IPC_CHANNELS.GET_COSTS, async () => {
    costScanner ||= new CostScanner(path.join(app.getPath('userData'), 'cost-cache.json'), costRoots)
    modelPrices ||= new ModelPrices(path.join(app.getPath('userData'), 'model-prices.json'))
    const first = !Object.keys(modelPrices.table).length
    const pricing = modelPrices.refresh()
    if (first) await pricing // 처음엔 가격표를 받은 뒤에 답한다
    void costScanner.scan()
    return costReport()
  })
  ipcMain.handle(IPC_CHANNELS.QUIT_APP, () => { app.quit() })
  // 정보 창의 링크: 이 프로젝트 GitHub 주소만 연다.
  // 웹 페이지 접속 암호: 정하면 해시만 저장하고, null이면 없앤다. 바뀌면 열려 있던 페이지는 다시 암호를 묻는다.
  ipcMain.handle(IPC_CHANNELS.SET_WEB_PASSWORD, (_event, password: unknown) => {
    if (password !== null && (typeof password !== 'string' || password.length < 4 || password.length > 128)) return false
    const { webPasswordHash: _old, ...rest } = accountStore.getConfig()
    accountStore.saveConfig(password === null ? rest : { ...rest, webPasswordHash: hashPassword(password) })
    applyWeb()
    broadcastState()
    return true
  })
  ipcMain.handle(IPC_CHANNELS.OPEN_WEB, async () => {
    if (web?.status.running) await shell.openExternal(`http://localhost:${accountStore.getConfig().webPort ?? DEFAULT_WEB_PORT}/`)
  })
  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, async (_event, url: string) => {
    if (typeof url !== 'string' || !/^https:\/\/github\.com\/(ngnearSINE\/ai-usage-widget|sallyHADEV\/ai-usage-taskbar-widget)(\/[\w./-]*)?$/.test(url)) return false
    await shell.openExternal(url); return true
  })
  ipcMain.handle(IPC_CHANNELS.PICK_FILE, async (event, kind: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender) || undefined
    const filters = process.platform === 'win32'
      ? [{ name: kind === 'cli' ? '실행 파일' : '프로그램·바로 가기', extensions: kind === 'cli' ? ['exe', 'cmd', 'bat'] : ['exe', 'lnk', 'url'] }, { name: '모든 파일', extensions: ['*'] }]
      : [{ name: '모든 파일', extensions: ['*'] }]
    const r = await dialog.showOpenDialog(win!, { title: kind === 'cli' ? 'Ctrl+두 번 클릭으로 실행할 CLI 고르기' : 'Shift+두 번 클릭으로 실행할 앱 고르기', properties: ['openFile'], filters })
    return r.canceled ? null : r.filePaths[0] || null
  })
  ipcMain.handle(IPC_CHANNELS.PICK_FOLDER, async (event, title?: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender) || undefined
    const r = await dialog.showOpenDialog(win!, { title: typeof title === 'string' && title ? title.slice(0, 80) : '로그인 폴더 고르기', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0] || null
  })
  // 두 번째 계정: Codex·Grok·Claude Code CLI의 다른 로그인 폴더. 그 폴더에 로그인 파일이 있어야 추가한다.
  ipcMain.handle(IPC_CHANNELS.ADD_HOME_ACCOUNT, (_event, provider: unknown, homeDir: unknown, name: unknown) => {
    if (provider !== 'codex' && provider !== 'xai' && provider !== 'claude') return { ok: false, message: '지원하지 않는 서비스예요.' }
    if (typeof homeDir !== 'string' || !path.isAbsolute(homeDir) || !fs.existsSync(homeDir) || !fs.statSync(homeDir).isDirectory()) return { ok: false, message: '폴더를 찾을 수 없어요.' }
    const svc = { codex: { file: 'auth.json', env: 'CODEX_HOME', cmd: 'codex login', title: 'Codex' }, xai: { file: 'auth.json', env: 'GROK_HOME', cmd: 'grok login', title: 'Grok' },
      claude: { file: '.credentials.json', env: 'CLAUDE_CONFIG_DIR', cmd: 'claude 로그인', title: 'Claude' } }[provider]
    if (!fs.existsSync(path.join(homeDir, svc.file))) {
      return { ok: false, message: `이 폴더에 로그인 정보가 없어요. 터미널에서 ${svc.env}를 이 폴더로 두고 ${svc.cmd}을 먼저 해 주세요.` }
    }
    const same = accountStore.getAccounts().find(a => a.provider === provider && path.resolve(a.homeDir || '') === path.resolve(homeDir))
    if (same) return { ok: false, message: `이미 '${same.name}' 카드로 추가돼 있어요.` }
    const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : `${svc.title} · ${path.basename(homeDir)}`
    accountStore.addAccount({ id: `${provider}-home-${Date.now()}`, name: label, provider, enabled: true, homeDir })
    broadcastState()
    if (!isPreview) void quotaManager.refreshAll().then(() => broadcastState())
    return { ok: true, message: `'${label}' 카드를 추가했어요.`, state: getAppState() }
  })
  // Ctrl+1~5 크기: 위젯 창(자유 창)과 작업 표시줄 팝업. 왼쪽 위를 그대로 두고 화면 안으로 맞춘다.
  ipcMain.handle(IPC_CHANNELS.SIZE_PRESET, (event, n: number) => {
    const i = Math.round(Number(n)) - 1
    if (!(i >= 0 && i < 5)) return null
    const win = BrowserWindow.fromWebContents(event.sender)
    const labels = ['아주 작게', '작게', '보통', '크게', '아주 크게']
    if (win && win === widgetWindow && accountStore.getConfig().placementMode === 'floating') {
      const st = getAppState(), cards = st.focus ? 1 : Math.max(1, visibleUsages(st.usages, st.accounts, st.config).length), gap = Math.max(4, Math.min(16, st.config.cardGap ?? 6))
      const sizes: Array<[number, number]> = [[220, 0], [320, 240], [480, 360], [700, 560], [980, 700]]
      const [w, h0] = sizes[i], h = Math.max(h0, Math.round(minWindowHeight(w / uiZoom(), cards, gap, !!accountStore.getConfig().hideHeader) * uiZoom()))
      const b = win.getBounds(), area = screen.getDisplayMatching(b).workArea
      const next = fitWindow({ x: b.x, y: b.y, width: Math.min(w, area.width), height: Math.min(h, area.height) }, area)
      win.setBounds(next)
      accountStore.saveConfig({ ...accountStore.getConfig(), windowBounds: next })
      rememberLayout()
      return labels[i]
    }
    if (win && win === popupWindow) {
      const sizes: Array<[number, number]> = [[300, 240], [360, 380], [420, 500], [520, 640], [640, 820]]
      const b = win.getBounds(), area = screen.getDisplayMatching(b).workArea, [w, h] = sizes[i]
      const next = fitWindow({ x: b.x + b.width - Math.min(w, area.width), y: b.y + b.height - Math.min(h, area.height), width: Math.min(w, area.width), height: Math.min(h, area.height) }, area)
      win.setBounds(next)
      savePopupBounds(next)
      return labels[i]
    }
    return null
  })
  ipcMain.handle(IPC_CHANNELS.SET_FOCUS, (_event, id: unknown) => setFocus(typeof id === 'string' ? id : null))
  ipcMain.handle(IPC_CHANNELS.CARD_MENU, (event, id: string) => showCardMenu(event.sender, String(id)))
  // 제목줄 메뉴(☰)·카드 기준(▾): 화면 안에 그리면 작은 창에서 잘리므로 Windows 기본 메뉴로 띄우고 고른 항목만 돌려준다.
  ipcMain.handle(IPC_CHANNELS.POPUP_MENU, (event, items: unknown, at: { x?: unknown; y?: unknown } | undefined) => new Promise<string | null>(resolve => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !Array.isArray(items) || items.length > 40) { resolve(null); return }
    let chosen: string | null = null
    const template = items.map((it): Electron.MenuItemConstructorOptions => it === '-' || !it || typeof it !== 'object'
      ? { type: 'separator' }
      : {
          label: String(it.label).slice(0, 80),
          ...(typeof it.on === 'boolean' ? { type: 'radio' as const, checked: it.on } : {}),
          ...(typeof it.check === 'boolean' ? { type: 'checkbox' as const, checked: it.check } : {}),
          ...(typeof it.accel === 'string' ? { accelerator: it.accel, registerAccelerator: false } : {}),
          click: () => { chosen = String(it.key) },
        })
    // 화면 좌표(CSS 픽셀)를 창 좌표로: 스케일(확대 비율)을 곱한다.
    const z = event.sender.getZoomFactor(), x = Math.round(Number(at?.x) * z), y = Math.round(Number(at?.y) * z)
    Menu.buildFromTemplate(template).popup({ window: win, ...(Number.isFinite(x) && Number.isFinite(y) ? { x, y } : {}), callback: () => setImmediate(() => resolve(chosen)) })
  }))
  // Ctrl+두 번 클릭은 CLI, Shift+두 번 클릭은 데스크톱 앱. 못 찾으면 false.
  ipcMain.handle(IPC_CHANNELS.OPEN_SERVICE_TOOL, async (_event, kind: unknown, id: unknown) => {
    const acc = accountStore.getAccounts().find(a => a.id === String(id))
    if (!acc) return false
    return kind === 'cli' ? openCli(acc) : kind === 'app' ? openApp(acc) : false
  })

  ipcMain.handle(IPC_CHANNELS.DETECT_LOCAL_APPS, async () => {
    return await LocalAppDetector.detectAll()
  })

  ipcMain.handle(IPC_CHANNELS.POPUP_READY, () => {
    revealPopup()
  })
}

app.whenReady().then(() => {
  accountStore = new AccountStore()
  // 지난번에 집중 모드로 보던 카드가 아직 있으면 이어서 그 카드만 보여 준다.
  const savedFocus = accountStore.getConfig().focusId
  focusId = savedFocus && accountStore.getAccounts().some(a => a.id === savedFocus) ? savedFocus : null
  quotaManager = new QuotaManager(accountStore, isPreview ? undefined : path.join(app.getPath('userData'), 'last-usage.json'))

  // 미리보기는 합성 기록으로 그래프를 보여 주고 파일에 쓰지 않는다.
  history = new UsageHistory(path.join(app.getPath('userData'), 'usage-history.json'), isPreview ? previewHistory(previewUsages(Date.now(), previewSpread())) : undefined,
    isPreview ? previewDaily(previewUsages(Date.now(), previewSpread()).map(u => u.id)) : undefined)
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const appIcon = [path.join(__dirname, '../public', iconFile), path.join(app.getAppPath(), 'public', iconFile), path.join(process.resourcesPath, 'public', iconFile)].find(p => fs.existsSync(p))
  // 알림을 누르면 위젯을 다시 보여 준다(숨겨 둔 경우 포함).
  updater = new Updater({
    preview: isPreview,
    onChange: () => { broadcastState(); updateTrayMenu() },
    onReady: version => notifier?.notice(`새 버전 ${version}이 준비됐어요`, accountStore.getConfig().autoUpdate === false ? '창·위젯 제목줄의 ‘업데이트’를 누르면 설치하고 다시 시작해요.' : `${accountStore.getConfig().updateHour ?? 3}시에 설치돼요. 제목줄의 ‘업데이트’로 지금 설치할 수도 있어요.`, () => openAboutWindow()),
  })
  updater.schedule(accountStore.getConfig().autoUpdate !== false, accountStore.getConfig().updateHour ?? 3)
  notifier = new UsageNotifier(path.join(app.getPath('userData'), 'notify-state.json'), appIcon, () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return
    widgetManuallyHidden = false
    widgetWindow.show()
    void updateWidgetBounds()
  })
  quotaManager.addProgressListener(() => broadcastState())
  quotaManager.addListener((usages) => {
    broadcastState()
    // 미리보기는 합성 데이터라 실제 알림을 만들지 않는다(테스트 알림은 가능).
    if (!isPreview) {
      history?.record(usages)
      notifier?.handle(usages, accountStore.getConfig())
    }
  })

  // 도킹을 못 하는 OS로 설정을 옮겨 왔으면 창 모드로 시작한다.
  if (!dockSupported && accountStore.getConfig().placementMode === 'docked') accountStore.saveConfig({ ...accountStore.getConfig(), placementMode: 'floating' })
  TaskbarDocker.warmHelper()
  warmLaunchers()
  void refreshLaunchers()
  refreshUsableRight()
  setupIpcHandlers()
  restoreLayout()
  createWidgetWindow()
  createPopupWindow()
  applySurface()
  web = new WebServer(path.join(__dirname, '../dist'), getAppState, broadcastState)
  applyWeb()
  createTray()
  registerShortcuts()
  if (!isPreview) applyAutoLaunch(accountStore.getConfig().openAtLogin ?? true)

  if (!isPreview) {
    // 적응형 조회: 화면이 잠겼거나 10분 넘게 입력이 없으면 느리게, 잠금·절전에서 돌아오면 바로 묻는다.
    let screenLocked = false
    quotaManager.setIdleProbe(() => screenLocked || powerMonitor.getSystemIdleTime() >= 600)
    powerMonitor.on('lock-screen', () => { screenLocked = true })
    powerMonitor.on('unlock-screen', () => { screenLocked = false; quotaManager.wake() })
    // 절전에서 깨면 네트워크가 붙을 때까지 잠깐 기다렸다 묻는다.
    powerMonitor.on('resume', () => { setTimeout(() => quotaManager.wake(), 5000) })
    quotaManager.startPolling(accountStore.getConfig().refreshIntervalSec)
  }

  startFullscreenWatch()

  // 디스플레이 해상도, 작업표시줄 크기 변화 또는 모니터 연결/해제 시 위젯 위치 재배치
  let lastMonitorKey = monitorKey()
  const onScreenChange = () => {
    const key = monitorKey()
    if (key !== lastMonitorKey) { lastMonitorKey = key; if (restoreLayout()) broadcastState() }
    updateWidgetBounds()
  }
  screen.on('display-metrics-changed', onScreenChange)
  screen.on('display-added', onScreenChange)
  screen.on('display-removed', onScreenChange)
})

/** 전체 화면 앱이 뜨면 자유 창 위젯을 숨긴다. 위젯과 같은 모니터인지 보려고 창 핸들을 넘기므로 위젯 창을 새로 만들면 다시 건다. */
function startFullscreenWatch() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  TaskbarDocker.startFullscreenWatcher(widgetWindow, (isFullscreen) => {
    if (!widgetWindow || widgetWindow.isDestroyed() || widgetManuallyHidden) return
    const cfg = accountStore.getConfig()
    if (cfg.placementMode === 'floating') {
      if (isFullscreen && widgetWindow.isVisible()) {
        widgetHiddenForFullscreen = true
        widgetWindow.hide()
        hidePopup(true)
      } else if (!isFullscreen && widgetHiddenForFullscreen) {
        widgetHiddenForFullscreen = false
        widgetWindow.show()
        updateWidgetBounds()
      }
    }
  })
}

app.on('window-all-closed', () => {
  // 트레이에 상주하므로 창이 닫혀도 앱 종료 방지
})

app.on('will-quit', () => { globalShortcut.unregisterAll(); web?.stop() })

// 작업표시줄에 붙은 채로 끝내면 먼저 떼어 낸다. 예전에는 동기 실행으로 떼어 냈는데, 보조 프로그램이 이 창에 보내는
// 메시지를 창 스레드가 막혀 받지 못해 종료가 수 초 멈췄다(실측 약 6초). 비동기로 떼어 내고 길어도 1.5초 뒤에는 끝낸다.
let quitReady = false, quitPending = false
app.on('before-quit', (event) => {
  if (!quitReady && widgetWindow && !widgetWindow.isDestroyed() && accountStore?.getConfig().placementMode === 'docked') {
    event.preventDefault()
    if (quitPending) return
    quitPending = true
    clearTimeout(dockRetryTimer); dockRepairPending = false
    TaskbarDocker.stopDockWatcher()
    const win = widgetWindow
    void Promise.race([TaskbarDocker.undockWindow(win), new Promise(r => setTimeout(r, 1500))])
      .finally(() => { quitReady = true; if (!win.isDestroyed()) win.hide(); app.quit() })
    return
  }
  clearTimeout(boundsSaveTimer)
  history?.flush()
  notifier?.flush()
  pointerProcess?.stop()
  tipWindow?.destroy()
  dockGhost?.destroy()
  if (widgetWindow && !widgetWindow.isDestroyed() && accountStore?.getConfig().placementMode === 'floating') {
    accountStore.saveConfig({ ...accountStore.getConfig(), windowBounds: widgetWindow.getBounds() })
  }
  cancelHidePopup()
  if (quotaManager) {
    quotaManager.stopPolling()
  }
  TaskbarDocker.stopStayTop()
  TaskbarDocker.stopFullscreenWatcher()
  TaskbarDocker.stopDockWatcher()
  TaskbarDocker.stopHelper()
  CodexAppServerClient.close()
  if (tray) {
    try {
      tray.destroy()
    } catch {}
    tray = null
  }
})
