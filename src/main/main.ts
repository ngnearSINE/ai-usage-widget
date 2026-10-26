import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from 'electron'
import os from 'node:os'
import { IPC_CHANNELS } from '../common/ipc-events.js'
import type { AccountConfig, AppState, WidgetConfig } from '../common/types.js'
import { AccountStore } from '../services/account-store.js'
import { QuotaManager } from '../services/quota-manager.js'
import { pushUsage } from '../services/usage-push.js'
import { calculatePopupPosition, calculateWidgetPosition, getTaskbarInfo } from './taskbar-position.js'
import { LocalAppDetector } from '../services/local-app-detector.js'
import { TaskbarDocker } from './taskbar-docker.js'
import { CodexAppServerClient } from '../services/codex-app-server-client.js'
import { detectLang, setLang, t } from '../common/i18n.js'
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, fitWindow, isDockTarget, visibleUsages } from '../common/widget-layout.js'
import { previewUsages } from '../common/preview-data.js'
import { roundedWindowShape } from '../common/window-shape.js'
import { UsageNotifier } from './notifier.js'
import { UsageHistory } from './history-store.js'
import { previewHistory } from '../common/history.js'
import { DESIGNS } from '../common/usage-model.js'
import { SurfaceWindow, surfaceKind } from './surface-window.js'

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
const acrylicSupported = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621
if (isPreview) {
  app.name = 'ai-usage-design-preview'
  app.setPath('userData', path.join(app.getPath('temp'), 'ai-usage-design-preview'))
}
// Windows 알림에 쓰는 앱 ID. 시작 메뉴 바로가기가 없는 로컬 빌드에서는 이 ID가 알림 머리에 그대로 보이므로 읽을 수 있는 이름으로 둔다.
if (process.platform === 'win32') app.setAppUserModelId(isPreview ? 'AI 사용량 (미리보기)' : 'AI 사용량')
let notifier: UsageNotifier | null = null
let history: UsageHistory | null = null
let shortcutErrors: string[] = []

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
  process.exit(0)
}

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
const DOUBLE_CLICK_WINDOW_MS = 500

function getAppState(): AppState {
  const usages = isPreview ? previewUsages().filter(u => accountStore.getAccounts().some(a => a.id === u.id && a.enabled)) : quotaManager.getUsages()
  return {
    preview: isPreview,
    acrylicSupported,
    config: accountStore.getConfig(),
    accounts: accountStore.getAccounts(),
    usages,
    isRefreshing: !isPreview && quotaManager.refreshing,
    lastRefreshedAt: usages.map(u => u.updatedAt).sort().at(-1) || '',
    history: history?.recent(),
    shortcutErrors
  }
}

function broadcastState() {
  const state = getAppState()
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send(IPC_CHANNELS.STATE_CHANGED, state)
  }
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send(IPC_CHANNELS.STATE_CHANGED, state)
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(IPC_CHANNELS.STATE_CHANGED, state)
  }
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
function servicePageUrl(accountId: string) {
  const acc = accountStore.getAccounts().find(a => a.id === accountId)
  const key = `${acc?.provider || ''} ${acc?.name || ''}`.toLowerCase()
  if (key.includes('claude')) return 'https://claude.ai/settings/usage'
  if (key.includes('codex') || key.includes('openai') || key.includes('gpt')) return 'https://chatgpt.com/codex/settings/usage'
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
    [s.toggle, '위젯 보이기/숨기기', () => { void toggleWidgetVisibility() }],
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
const SETTINGS_TABS = ['design', 'display', 'services', 'alerts', 'history', 'convenience', 'accounts', 'general', 'api'] as const
type SettingsTab = typeof SETTINGS_TABS[number]
// 설정 창도 위젯과 같은 배경(불투명도·아크릴)을 쓰도록 테두리 없는 공통 창으로 만들고, 창 단추는 화면이 그린다.
function openSettingsWindow(tab: SettingsTab = 'design', bounds?: Electron.Rectangle) {
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
  const width = Math.min(1000, area.width - 40), height = Math.min(680, area.height - 40)
  const win = settingsWindow = new SurfaceWindow({
    ...(bounds || { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height }),
    minWidth: 760, minHeight: 520, show: false, title: 'AI 사용량 설정', resizable: true, maximizable: true, autoHideMenuBar: true,
    webPreferences: { preload: getPreloadPath(), nodeIntegration: false, contextIsolation: true }
  }, currentSurfaceKind())
  win.on('page-title-updated', event => event.preventDefault())
  win.once('ready-to-show', () => { win.show(); applyWindowShape(win, 'native') })
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
    old.destroy()
    openSettingsWindow('design',bounds)
  }
}

function applyWindowTopmost(config: WidgetConfig) {
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

// 레이아웃(dock/undock/setBounds)은 동시 실행 시 서로의 HWND 상태를 덮어쓰므로 직렬 큐로 실행
let layoutQueue: Promise<void> = Promise.resolve()
let dockRepairPending = false

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
    TaskbarDocker.startDockWatcher(
      widgetWindow,
      () => handleDockedWidgetClick(),
      () => {
        console.log('[Main] Explorer restart or dock lost detected, re-docking widget...')
        dockRepairPending = true
        updateWidgetBounds()
      },
      () => { void beginWindowInteraction('move') }
    )
  } else if (dockRepairPending) {
    // Explorer 재시작 직후에는 작업표시줄이 아직 없을 수 있으므로 복구 중일 때만 재시도
    setTimeout(() => updateWidgetBounds(), 3000)
  } else {
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
    setTimeout(() => { if (!interacting) showDockHint(false, undefined, undefined, true) }, 1500)
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
let dockHint: BrowserWindow | null = null
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
  return Math.max(80,24+136*visibleUsages(state.usages,state.accounts,state.config).length)
}

function showDockHint(visible: boolean, area?: Electron.Rectangle, point?: {x:number;y:number}, preload = false, ghostWidth = dockWidth()) {
  // 드래그 중 매 좌표마다 호출되므로 숨김 상태가 유지되면 창 배치를 건너뛴다.
  if (!visible && !preload) { if (dockPreviewVisible) { dockHint?.hide(); dockGhost?.hide() } dockPreviewVisible=false; return }
  dockPreviewVisible=visible
  const cursor=point || screen.getCursorScreenPoint()
  const display=screen.getDisplayNearestPoint(cursor)
  const workArea=area || display.workArea
  if (!dockHint) {
    dockHint = new BrowserWindow({ width: 240, height: 44, frame: false, transparent: true, show: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: { nodeIntegration: false, contextIsolation: true } })
    dockHint.setIgnoreMouseEvents(true)
    void dockHint.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html lang="ko"><body style="margin:0;background:#b7a6ff;color:#171326;border:1px solid #e1d9ff;border-radius:12px;font:600 12px Segoe UI,sans-serif;display:grid;place-items:center;height:40px;box-sizing:border-box">↓ 마우스를 놓으면 도킹됩니다</body></html>'))
  }
  dockHint.setBounds({x:Math.round(Math.max(workArea.x+8,Math.min(cursor.x+18,workArea.x+workArea.width-248))),y:Math.round(Math.max(workArea.y+8,cursor.y-64)),width:240,height:44})
  applyWindowShape(dockHint,12)
  if(visible) dockHint.showInactive(); else dockHint.hide()
  if (!dockGhost) {
    const height=getTaskbarInfo(display).taskbarHeight
    dockGhost=new BrowserWindow({width:ghostWidth,height,frame:false,transparent:true,show:false,focusable:false,skipTaskbar:true,alwaysOnTop:true,
      title:'도킹 미리보기',webPreferences:{preload:getPreloadPath(),nodeIntegration:false,contextIsolation:true}})
    dockGhost.on('page-title-updated',event=>event.preventDefault())
    dockGhost.setIgnoreMouseEvents(true)
    dockGhost.setOpacity(.58)
    dockGhost.webContents.once('did-finish-load',()=>{if(dockPreviewVisible)dockGhost?.showInactive()})
    if(process.env.VITE_DEV_SERVER_URL) void dockGhost.loadURL(`${process.env.VITE_DEV_SERVER_URL}?view=dock-preview&dockHeight=${height}`)
    else void dockGhost.loadFile(path.join(__dirname,'../dist/index.html'),{query:{view:'dock-preview',dockHeight:String(height)}})
  }
  const width=Math.min(ghostWidth,display.bounds.width)
  const height=getTaskbarInfo(display).taskbarHeight
  const x=Math.max(display.bounds.x,Math.min(cursor.x-100,display.bounds.x+display.bounds.width-width))
  dockGhost.setBounds({x:Math.round(x),y:display.bounds.y+display.bounds.height-height,width,height})
  if(visible) dockGhost.showInactive(); else dockGhost.hide()
}

async function setPlacement(mode: 'floating' | 'docked') {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  const previous = accountStore.getConfig()
  if (previous.placementMode === mode) return
  if (mode === 'floating') {
    TaskbarDocker.stopDockWatcher()
    const detached = await TaskbarDocker.undockWindow(widgetWindow)
    if (!detached) throw new Error('작업표시줄에서 창을 분리하지 못했습니다.')
  } else {
    clearTimeout(boundsSaveTimer)
    if (previous.placementMode === 'floating') previous.windowBounds = widgetWindow.getBounds()
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

// 렌더러가 포인터를 잡고 있는 자유 창 제스처는 IPC 좌표로 직접 움직인다.
// 외부 포인터 감시 프로세스는 작업표시줄에 도킹된 창을 끌어낼 때만 쓴다(프로세스 기동 지연·폴링 간격 회피).
let interactionMove: ((p: {x:number;y:number}) => void) | null = null

async function beginWindowInteraction(kind: string, pointerOrigin?: {x:number;y:number}, rendererDriven = false) {
  if (interacting || !widgetWindow || widgetWindow.isDestroyed() || !/^(move|resize-(n|s|e|w|ne|nw|se|sw))$/.test(kind)) return
  interacting = true
  const startedDocked = accountStore.getConfig().placementMode === 'docked'
  const pointerFromRenderer = rendererDriven && !startedDocked
  let leftDockArea = !startedDocked
  hidePopup(true)
  // UIA 클라이언트(접근성 도구 등)가 켜진 PC에서는 활성 창의 접근성 트리를 주기적으로 읽어 UI 스레드가 50~70ms씩 멈춘다.
  // 끌기 위한 클릭으로 위젯이 활성화되면 그 멈춤이 이동 끊김으로 보이므로 제스처 동안 활성 상태를 내려놓는다.
  if (widgetWindow.isFocused()) widgetWindow.blur()
  const origin = pointerOrigin && Number.isFinite(pointerOrigin.x) && Number.isFinite(pointerOrigin.y)
    ? { x: Math.round(pointerOrigin.x), y: Math.round(pointerOrigin.y) } : screen.getCursorScreenPoint()
  try {
    if (accountStore.getConfig().placementMode !== 'floating') {
      await setPlacement('floating')
      const restored = widgetWindow.getBounds()
      widgetWindow.setBounds({ ...restored, x: origin.x - Math.min(restored.width / 2, 160), y: origin.y - 24 })
    }
    const start = widgetWindow.getBounds()
    const ghostWidth = dockWidth()
    if(kind==='move') showDockHint(false,undefined,origin,true,ghostWidth)
    let last = origin
    let moved = false
    const update = (p: { x: number; y: number }) => {
      if (!widgetWindow || widgetWindow.isDestroyed()) return
      if (p.x === last.x && p.y === last.y && moved) return
      last = p
      const dx = p.x - origin.x, dy = p.y - origin.y
      moved ||= Math.abs(dx) + Math.abs(dy) > 5
      if (kind === 'move') {
        widgetWindow.setPosition(Math.round(start.x + dx), Math.round(start.y + dy), false)
        const display = screen.getDisplayNearestPoint(p)
        const target = isDockTarget(p, display.bounds, display.workArea)
        if (!target) leftDockArea = true
        showDockHint(leftDockArea && target, display.workArea,p,false,ghostWidth)
      } else {
        const edge = kind.slice(7)
        let { x, y, width, height } = start
        if (edge.includes('e')) width = Math.max(MIN_WINDOW_SIZE.width, start.width + dx)
        if (edge.includes('s')) height = Math.max(MIN_WINDOW_SIZE.height, start.height + dy)
        if (edge.includes('w')) { width = Math.max(MIN_WINDOW_SIZE.width, start.width - dx); x = start.x + start.width - width }
        if (edge.includes('n')) { height = Math.max(MIN_WINDOW_SIZE.height, start.height - dy); y = start.y + start.height - height }
        widgetWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
      }
    }
    const finish = async (p?: { x: number; y: number }) => {
      if (!interacting) return
      if (p) update(p)
      showDockHint(false)
      interacting = false
      endInteraction = null
      interactionMove = null
      pointerProcess?.stop()
      pointerProcess = null
      if (!widgetWindow || widgetWindow.isDestroyed()) return
      const display = screen.getDisplayNearestPoint(last)
      if (kind === 'move' && moved && leftDockArea && isDockTarget(last, display.bounds, display.workArea)) {
        const config = accountStore.getConfig()
        const safe = fitWindow(widgetWindow.getBounds(), display.workArea)
        accountStore.saveConfig({ ...config, windowBounds: safe, alignment: 'left', offsetPx: Math.max(0, last.x - display.bounds.x - 100), verticalOffsetPx: 0 })
        // setPlacement가 저장하는 마지막 자유 창 좌표도 화면 안으로 유지한다.
        widgetWindow.setBounds(safe)
        await setPlacement('docked')
      } else {
        const bounds = fitWindow(widgetWindow.getBounds(), display.workArea)
        widgetWindow.setBounds(bounds)
        accountStore.saveConfig({ ...accountStore.getConfig(), windowBounds: bounds })
        rememberLayout()
      }
    }
    endInteraction = finish
    if (pointerFromRenderer) interactionMove = update
    else pointerProcess = TaskbarDocker.watchPointer(update, p => { void finish(p).catch(console.error) })
  } catch (err) {
    interacting = false
    interactionMove = null
    showDockHint(false)
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

  const popupPos = calculatePopupPosition(widgetX, widgetW, POPUP_WIDTH, POPUP_HEIGHT, widgetY)

  popupWindow.setBounds({
    x: popupPos.x,
    y: popupPos.y,
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT
  })
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
    resizable: false,
    show: false,
    title: 'AI 사용량 · 고급 설정',
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true
    }
  }, currentSurfaceKind())
  popupWindow.on('page-title-updated', event => event.preventDefault())
  popupWindow.on('resize',()=>{if(popupWindow)applyWindowShape(popupWindow,'native')})

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
      popupWindow.focus()
    } else {
      popupWindow.showInactive()
    }
    popupWindow.webContents.send(IPC_CHANNELS.POPUP_OPENED, getAppState())
  } else if (focus) {
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
    popupWindow.hide()
  }
}

// 도킹 모드 위젯 클릭: 네이티브 워처가 물리 클릭마다 CLICK 한 줄을 보내므로,
// 더블클릭 설정이 켜져 있으면 여기서 500ms 창으로 두 번째 클릭을 기다렸다가 연다.
function handleDockedWidgetClick() {
  if (!accountStore.getConfig().doubleClickToOpenPopup) {
    lastDockedWidgetClickAt = 0
    void togglePopup()
    return
  }

  const now = Date.now()
  if (lastDockedWidgetClickAt > 0 && now - lastDockedWidgetClickAt <= DOUBLE_CLICK_WINDOW_MS) {
    lastDockedWidgetClickAt = 0
    void togglePopup()
  } else {
    lastDockedWidgetClickAt = now
  }
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

function applyAutoLaunch(enable: boolean) {
  if (isPreview) return
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

    app.setLoginItemSettings({
      openAtLogin: enable,
      path: process.execPath,
      args: ['--hidden']
    })
    updateTrayMenu()
  } catch (err) {
    console.warn('[Main] Failed to setLoginItemSettings:', err)
  }
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  const config = accountStore.getConfig()
  const isAutoStart = app.isPackaged
    ? (app.getLoginItemSettings().openAtLogin ?? config.openAtLogin ?? true)
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
    {
      label: t('trayOpenPopup'),
      click: () => {
        showPopup(true, true)
      }
    },
    {
      label: '설정',
      click: () => openSettingsWindow('design')
    },
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

  tray.on('click', () => {
    togglePopup()
  })
}

function setupIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.GET_STATE, () => {
    return getAppState()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_CONFIG, async (_event, patch: Partial<WidgetConfig>) => {
    const prevConfig = accountStore.getConfig()
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
    if (patch.refreshIntervalSec !== undefined && prevConfig.refreshIntervalSec !== nextConfig.refreshIntervalSec) {
      if (!isPreview) quotaManager.startPolling(nextConfig.refreshIntervalSec, false)
    }

    // 모드 전환 감지 (docked <-> floating)
    if (requestedMode && requestedMode !== prevConfig.placementMode) await setPlacement(requestedMode)
    else if (nextConfig.placementMode === 'docked' && ['offsetPx', 'alignment', 'verticalOffsetPx'].some(k => k in patch)) await updateWidgetBounds()
    if (patch.alwaysOnTop !== undefined) applyWindowTopmost(accountStore.getConfig())
    if (patch.appearance !== undefined || patch.useAcrylic !== undefined || patch.opacity !== undefined) applySurface()
    if (patch.clickThrough !== undefined) { applyClickThrough(); updateTrayMenu() }
    if (patch.design !== undefined || patch.rememberPerMonitor === true) rememberLayout()
    if (patch.shortcuts !== undefined) { registerShortcuts(); updateTrayMenu() }
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
    const newAcc: AccountConfig = {
      id: acc.id || `custom-${Date.now()}`,
      name: acc.name || 'Custom Account',
      provider: acc.provider || 'custom',
      enabled: true,
      customMock: acc.customMock || {
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
  ipcMain.handle(IPC_CHANNELS.HIDE_ACCOUNT, (_event, id: string, hidden: boolean) => {
    accountStore.hideAccount(id, hidden)
    broadcastState()
    return getAppState()
  })
  ipcMain.handle(IPC_CHANNELS.BEGIN_INTERACTION, (_event, kind: string, origin?: {x:number;y:number}) => beginWindowInteraction(kind, origin, true))
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
    widgetWindow?.hide()
    hidePopup(true)
  })

  ipcMain.handle(IPC_CHANNELS.SHOW_POPUP, async () => {
    await showPopup(false, false)
  })

  ipcMain.handle(IPC_CHANNELS.HIDE_POPUP, () => {
    hidePopup(true)
  })

  ipcMain.handle(IPC_CHANNELS.TOGGLE_POPUP, async () => {
    await togglePopup()
  })

  ipcMain.handle(IPC_CHANNELS.LOCK_POPUP, () => {
    isPopupLocked = true
    cancelHidePopup()
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
  ipcMain.on(IPC_CHANNELS.WINDOW_CONTROL, (event, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== settingsWindow) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize() }
    else if (action === 'close') win.close()
  })
  ipcMain.handle(IPC_CHANNELS.OPEN_SERVICE_PAGE, async (_event, accountId: string) => {
    const url = servicePageUrl(String(accountId))
    if (!url) return false
    await shell.openExternal(url)
    return true
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

  ipcMain.handle(IPC_CHANNELS.DETECT_LOCAL_APPS, async () => {
    return await LocalAppDetector.detectAll()
  })

  ipcMain.handle(IPC_CHANNELS.SCHEDULE_HIDE_POPUP, (_event, delayMs?: number) => {
    scheduleHidePopup(delayMs || 400)
  })

  ipcMain.handle(IPC_CHANNELS.CANCEL_HIDE_POPUP, () => {
    cancelHidePopup()
  })

  ipcMain.handle(IPC_CHANNELS.POPUP_READY, () => {
    revealPopup()
  })
}

app.whenReady().then(() => {
  accountStore = new AccountStore()
  quotaManager = new QuotaManager(accountStore)

  // 미리보기는 합성 기록으로 그래프를 보여 주고 파일에 쓰지 않는다.
  history = new UsageHistory(path.join(app.getPath('userData'), 'usage-history.json'), isPreview ? previewHistory(previewUsages()) : undefined)
  const appIcon = [path.join(__dirname, '../public/icon.ico'), path.join(app.getAppPath(), 'public/icon.ico'), path.join(process.resourcesPath, 'public/icon.ico')].find(p => fs.existsSync(p))
  // 알림을 누르면 위젯을 다시 보여 준다(숨겨 둔 경우 포함).
  notifier = new UsageNotifier(path.join(app.getPath('userData'), 'notify-state.json'), appIcon, () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return
    widgetManuallyHidden = false
    widgetWindow.show()
    void updateWidgetBounds()
  })
  quotaManager.addListener((usages) => {
    broadcastState()
    void pushUsage(usages, accountStore.getConfig())
    // 미리보기는 합성 데이터라 실제 알림을 만들지 않는다(테스트 알림은 가능).
    if (!isPreview) {
      history?.record(usages)
      notifier?.handle(usages, accountStore.getConfig())
    }
  })

  TaskbarDocker.warmHelper()
  setupIpcHandlers()
  restoreLayout()
  createWidgetWindow()
  createPopupWindow()
  applySurface()
  createTray()
  registerShortcuts()
  if (!isPreview) applyAutoLaunch(accountStore.getConfig().openAtLogin ?? true)

  if (!isPreview) quotaManager.startPolling(accountStore.getConfig().refreshIntervalSec)

  TaskbarDocker.startFullscreenWatcher(widgetWindow!, (isFullscreen) => {
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

app.on('window-all-closed', () => {
  // 트레이에 상주하므로 창이 닫혀도 앱 종료 방지
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('before-quit', () => {
  clearTimeout(boundsSaveTimer)
  pointerProcess?.stop()
  dockHint?.destroy()
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
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    const cfg = accountStore.getConfig()
    // 종료 중에는 상주 보조 프로세스가 먼저 닫힐 수 있으므로 동기로 분리한다.
    if (cfg.placementMode !== 'floating') TaskbarDocker.undockWindowSync(widgetWindow)
  }
  TaskbarDocker.stopHelper()
  CodexAppServerClient.close()
  if (tray) {
    try {
      tray.destroy()
    } catch {}
    tray = null
  }
})
