import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { app, screen, type BrowserWindow } from 'electron'
import type { WidgetConfig } from '../common/types.js'
import { calculateWidgetPosition } from './taskbar-position.js'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

type Pending = { resolve: (r: { code: number; out: string }) => void; onLine?: (line: string) => void }

/**
 * TaskbarDock.exe 상주 연결. 명령마다 프로세스를 띄우면 생성·.NET 기동에만 약 150ms가 들어
 * 도킹 넣기·빼기가 수백 ms씩 걸렸다. 한 프로세스를 띄워 두고 stdin 한 줄로 명령을 보내면 수 ms에 끝난다.
 * 상주 프로세스를 쓸 수 없으면 기존처럼 명령마다 실행한다.
 */
class NativeHelper {
  private proc: ChildProcess | null = null
  private ready: Promise<boolean> | null = null
  private buffer = ''
  private seq = 0
  private pending = new Map<string, Pending>()

  constructor(private exe: () => string) {}

  private start(): Promise<boolean> {
    if (this.ready) return this.ready
    this.ready = new Promise<boolean>(resolve => {
      let proc: ChildProcess
      try { proc = spawn(this.exe(), ['serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }) }
      catch { this.ready = null; resolve(false); return }
      this.proc = proc
      this.buffer = ''
      const fail = () => {
        if (this.proc !== proc) return
        this.proc = null
        this.ready = null
        resolve(false)
        // 응답을 기다리던 명령은 실패로 돌려준다(다음 명령은 새 프로세스로).
        for (const p of this.pending.values()) p.resolve({ code: -1, out: '' })
        this.pending.clear()
      }
      proc.on('error', fail)
      proc.on('exit', fail)
      proc.stdin?.on('error', fail)
      proc.stdout?.on('data', chunk => {
        this.buffer += chunk.toString()
        const lines = this.buffer.split(/\r?\n/)
        this.buffer = lines.pop() || ''
        for (const line of lines) {
          if (line === 'READY') { resolve(true); continue }
          const m = /^([RS]) (\d+) ?(.*)$/.exec(line)
          if (!m) continue
          const p = this.pending.get(m[2])
          if (!p) continue
          if (m[1] === 'S') { p.onLine?.(m[3]); continue }
          const sp = m[3].indexOf(' ')
          const code = Number(sp < 0 ? m[3] : m[3].slice(0, sp))
          this.pending.delete(m[2])
          p.resolve({ code, out: sp < 0 ? '' : m[3].slice(sp + 1).split('\u001e').join('\n') })
        }
      })
    })
    return this.ready
  }

  /** 명령을 실행하고 종료 코드와 출력을 돌려준다. */
  async run(args: string[], onLine?: (line: string) => void): Promise<{ code: number; out: string }> {
    if (await this.start() && this.proc?.stdin?.writable) {
      const id = String(++this.seq)
      return new Promise(resolve => {
        this.pending.set(id, { resolve, onLine })
        this.proc!.stdin!.write(`${id} ${args.join(' ')}\n`)
      })
    }
    if (onLine) return { code: -1, out: '' }
    try {
      const { stdout } = await execFileAsync(this.exe(), args, { windowsHide: true })
      return { code: 0, out: stdout.trim() }
    } catch (err: any) {
      return { code: typeof err?.code === 'number' ? err.code : -1, out: String(err?.stdout || '').trim() }
    }
  }

  /** 앱 시작 때 미리 띄워 첫 도킹도 바로 응답하게 한다. */
  warm() { void this.start() }

  stop() {
    try { this.proc?.stdin?.end(); this.proc?.kill() } catch {}
    this.proc = null
    this.ready = null
  }
}

export interface DockResult {
  success: boolean
  taskbarHwnd?: string
  widgetHwnd?: string
  clientRect?: { x: number; y: number; width: number; height: number }
  screenRect?: { x: number; y: number; width: number; height: number }
  dpi?: number
  rawOutput?: string
  error?: string
}

export class TaskbarDocker {
  private static dockerExePath: string | null = null
  private static stayTopProcess: ChildProcess | null = null
  private static fsWatchProcess: ChildProcess | null = null
  private static dockWatchProcess: ChildProcess | null = null
  private static dockWatchKey = ''
  private static lastTaskbarHwnd: string | null = null
  // Chromium이 child 창 client에서 빼는 프레임 높이. 한 번 재면 다음 도킹부터 바로 보상해 dock을 두 번 실행하지 않는다.
  private static dockInset = 0
  private static helper = new NativeHelper(() => TaskbarDocker.getDockerPath())

  public static warmHelper(): void { if (process.platform === 'win32' && fs.existsSync(this.getDockerPath())) this.helper.warm() }
  public static stopHelper(): void { this.helper.stop() }

  public static getDockerPath(): string {
    if (this.dockerExePath && fs.existsSync(this.dockerExePath)) return this.dockerExePath

    const candidates = [
      path.join(app.getAppPath(), 'native/TaskbarDock.exe'),
      path.join(process.resourcesPath || '', 'native/TaskbarDock.exe'),
      path.join(path.dirname(app.getPath('exe')), 'native/TaskbarDock.exe'),
      path.join(__dirname, '../../native/TaskbarDock.exe'),
      path.join(__dirname, '../native/TaskbarDock.exe')
    ]

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        this.dockerExePath = p
        return p
      }
    }

    this.dockerExePath = candidates[0]
    return this.dockerExePath
  }

  public static getHwnd(win: BrowserWindow): string {
    const handleBuf = win.getNativeWindowHandle()
    try {
      const hwndBig = handleBuf.readBigUInt64LE(0)
      return '0x' + hwndBig.toString(16)
    } catch {
      const hwndInt = handleBuf.readUInt32LE(0)
      return '0x' + hwndInt.toString(16)
    }
  }

  /**
   * Windows 작업표시줄(Shell_TrayWnd 또는 Shell_SecondaryTrayWnd)의 child HWND로 위젯 도킹
   */
  public static async dockWindow(
    win: BrowserWindow,
    config: WidgetConfig,
    width: number,
    height: number,
    contentPadding = this.dockInset,
    retry = true
  ): Promise<DockResult> {
    if (!win || win.isDestroyed()) {
      return { success: false, error: 'Window is destroyed or null' }
    }

    const exe = this.getDockerPath()
    if (!fs.existsSync(exe)) {
      console.warn('[TaskbarDocker] Docker executable not found:', exe)
      return { success: false, error: 'Executable not found' }
    }

    const hwnd = this.getHwnd(win)
    const align = config.alignment || 'right'
    const offset = config.offsetPx ?? 12
    const vOffset = config.verticalOffsetPx ?? 0

    // 대상 모니터 영역 추출
    const display = screen.getDisplayMatching(win.getBounds()) || screen.getPrimaryDisplay()
    const mon = display.bounds
    const monStr = `${mon.x},${mon.y},${mon.x + mon.width},${mon.y + mon.height}`

    const args = [
      'dock',
      hwnd,
      String(width),
      String(height),
      align,
      String(offset),
      String(vOffset),
      monStr,
      String(contentPadding)
    ]

    console.log(`[TaskbarDocker] Docking HWND ${hwnd} with args:`, args.join(' '))

    try {
      const { out } = await this.helper.run(args)
      console.log(`[TaskbarDocker] Dock execution output:\n${out}`)

      if (out.includes('DOCKED_OK')) {
        // DOCKED_OK taskbar:0x... widget:0x... client:x,y,w,h screen:x,y,w,h dpi:...
        const taskbarMatch = out.match(/taskbar:(0x[0-9a-fA-F]+)/)
        const widgetMatch = out.match(/widget:(0x[0-9a-fA-F]+)/)
        const clientMatch = out.match(/client:([-\d]+),([-\d]+),([-\d]+),([-\d]+)/)
        const screenMatch = out.match(/screen:([-\d]+),([-\d]+),([-\d]+),([-\d]+)/)
        const dpiMatch = out.match(/dpi:(\d+)/)

        if (taskbarMatch) {
          this.lastTaskbarHwnd = taskbarMatch[1]
        }

        // 창 높이 = 작업표시줄 + 보상값, 실제 client = 창 높이 - 프레임. client가 작업표시줄과 같아지는 보상값을 구한다.
        const taskbarHeight = Number(out.match(/Taskbar client = \d+x(\d+)/)?.[1])
        const scale = Number(dpiMatch?.[1] || 96) / 96
        const actualContentHeight = Math.round(win.getContentSize()[1] * scale)
        const inset = taskbarHeight + contentPadding - actualContentHeight
        if (retry && inset !== contentPadding && inset >= 0 && inset <= 128) {
          this.dockInset = inset
          return this.dockWindow(win, config, width, height, inset, false)
        }

        return {
          success: true,
          taskbarHwnd: taskbarMatch?.[1],
          widgetHwnd: widgetMatch?.[1] || hwnd,
          clientRect: clientMatch ? {
            x: parseInt(clientMatch[1], 10),
            y: parseInt(clientMatch[2], 10),
            width: parseInt(clientMatch[3], 10),
            height: parseInt(clientMatch[4], 10)
          } : undefined,
          screenRect: screenMatch ? {
            x: parseInt(screenMatch[1], 10),
            y: parseInt(screenMatch[2], 10),
            width: parseInt(screenMatch[3], 10),
            height: parseInt(screenMatch[4], 10)
          } : undefined,
          dpi: dpiMatch ? parseInt(dpiMatch[1], 10) : undefined,
          rawOutput: out
        }
      }

      return { success: false, error: out, rawOutput: out }
    } catch (err: any) {
      console.error('[TaskbarDocker] Dock execution failed:', err)
      return { success: false, error: err.message, rawOutput: err.stdout }
    }
  }

  /**
   * 작업표시줄에서 분리하여 독립 창으로 복원 (플로팅 전환 시 사용)
   */
  public static async undockWindow(win: BrowserWindow): Promise<boolean> {
    if (!win || win.isDestroyed()) return false

    const exe = this.getDockerPath()
    if (!fs.existsSync(exe)) return false

    const hwnd = this.getHwnd(win)
    try {
      const { out } = await this.helper.run(['undock', hwnd])
      this.lastTaskbarHwnd = null
      return out.includes('UNDOCKED_OK')
    } catch (err) {
      console.warn('[TaskbarDocker] Undock failed:', err)
      return false
    }
  }

  public static undockWindowSync(win: BrowserWindow): void {
    if (!win || win.isDestroyed() || !fs.existsSync(this.getDockerPath())) return
    try { execFileSync(this.getDockerPath(), ['undock', this.getHwnd(win)], { windowsHide: true, timeout: 2000 }) } catch {}
  }

  /** Windows 11 DWM 둥근 모서리. 아크릴 backdrop까지 함께 잘리는 유일한 경로다. */
  public static setCornerPreference(win: BrowserWindow, preference: 'round' | 'none'): void {
    if (process.platform !== 'win32' || !win || win.isDestroyed()) return
    const exe = this.getDockerPath()
    if (!fs.existsSync(exe)) return
    void this.helper.run(['corner', this.getHwnd(win), preference]).then(r => {
      if (r.code !== 0) console.warn('[TaskbarDocker] Corner preference failed:', r.code)
    })
  }

  /**
   * 팝업 앵커링을 위한 위젯의 실제 화면 절대 좌표(GetWindowRect) 조회
   */
  public static async getWidgetScreenRect(
    win: BrowserWindow
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    if (!win || win.isDestroyed()) return null

    const exe = this.getDockerPath()
    if (!fs.existsSync(exe)) return win.getBounds()

    const hwnd = this.getHwnd(win)
    try {
      const { out } = await this.helper.run(['getscreenrect', hwnd])
      const parts = out.trim().split(',')
      if (parts.length === 4) {
        return {
          x: parseInt(parts[0], 10),
          y: parseInt(parts[1], 10),
          width: parseInt(parts[2], 10),
          height: parseInt(parts[3], 10)
        }
      }
    } catch (err) {
      console.warn('[TaskbarDocker] getscreenrect failed, falling back to win.getBounds():', err)
    }

    return win.getBounds()
  }

  /**
   * 도킹 모드 전용 상주 워처: 단일 TaskbarDock.exe watch 프로세스가 클릭과 도킹 유실을 stdout으로 통지
   * (주기적 프로세스 생성은 Windows AppStarting 커서를 유발하므로 금지)
   */
  public static startDockWatcher(win: BrowserWindow, onClick: () => void, onDockLost: () => void, onDrag?: () => void): void {
    if (!win || win.isDestroyed() || !this.lastTaskbarHwnd) return this.stopDockWatcher()

    // 같은 위젯/작업표시줄로 재도킹(크기 변경 등)이면 살아 있는 워처를 그대로 재사용
    const hwnd = this.getHwnd(win)
    const key = `${hwnd}:${this.lastTaskbarHwnd}`
    if (this.dockWatchProcess && this.dockWatchProcess.exitCode === null && this.dockWatchKey === key) return
    this.stopDockWatcher()

    const exe = this.getDockerPath()
    if (!fs.existsSync(exe)) return

    this.dockWatchKey = key
    console.log(`[TaskbarDocker] Starting dock watcher for HWND ${hwnd} (taskbar ${this.lastTaskbarHwnd})...`)

    try {
      const proc = spawn(exe, ['watch', hwnd, this.lastTaskbarHwnd], { windowsHide: true })
      this.dockWatchProcess = proc
      let buffer = ''

      proc.stdout?.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''

        for (const line of lines) {
          const msg = line.trim()
          if (msg === 'CLICK') {
            console.log('[TaskbarDocker] Native click detected on docked HWND, toggling popup')
            onClick()
          } else if (msg === 'DRAG_START') {
            onDrag?.()
          } else if (msg === 'DOCK_LOST' && this.dockWatchProcess === proc) {
            console.warn('[TaskbarDocker] Dock lost. Triggering re-dock repair...')
            this.dockWatchProcess = null
            onDockLost()
          }
        }
      })

      proc.on('error', (err) => {
        console.warn('[TaskbarDocker] watch process error:', err)
      })
    } catch (err) {
      console.error('[TaskbarDocker] Failed to spawn watch:', err)
    }
  }

  public static stopDockWatcher(): void {
    if (this.dockWatchProcess) {
      try {
        this.dockWatchProcess.kill()
      } catch {}
      this.dockWatchProcess = null
    }
  }

  /** 마우스 버튼을 놓을 때까지 포인터 좌표(DIP)를 보낸다. 반환값의 stop()은 이후 좌표를 무시한다. */
  public static watchPointer(onMove: (p: { x: number; y: number }) => void, onEnd: (p?: { x: number; y: number }) => void): { stop(): void } | null {
    if (!fs.existsSync(this.getDockerPath())) { onEnd(); return null }
    let ended = false
    const finish = (p?: { x: number; y: number }) => { if (!ended) { ended = true; onEnd(p) } }
    void this.helper.run(['pointerwatch'], line => {
      const m = /^(MOVE|END):(-?\d+),(-?\d+)$/.exec(line.trim())
      if (!m || ended) return
      const p = screen.screenToDipPoint({ x: Number(m[2]), y: Number(m[3]) })
      if (m[1] === 'END') finish(p)
      else onMove(p)
    }).then(() => finish())
    return { stop: () => { ended = true } }
  }

  /**
   * 창 전체를 투명하게 숨기거나(true) 되돌린다(false). Electron setOpacity는 한 번 layered가 된 창을 되돌리지 않아
   * 아크릴이 사라지므로 아크릴 창은 이 함수로 표시 직전 깜빡임을 가린다.
   */
  public static async setFaded(win: BrowserWindow, faded: boolean): Promise<boolean> {
    if (process.platform !== 'win32' || !win || win.isDestroyed() || !fs.existsSync(this.getDockerPath())) return false
    return (await this.helper.run(['fade', this.getHwnd(win), faded ? '0' : 'off'])).code === 0
  }

  /** 도킹된 위젯을 작업표시줄 안에서 가로로만 옮긴다(왼쪽 기준 논리 픽셀). 끌기 중 매 좌표마다 써도 가볍다. */
  public static async slideDocked(win: BrowserWindow, offset: number): Promise<boolean> {
    if (process.platform !== 'win32' || !win || win.isDestroyed() || !fs.existsSync(this.getDockerPath())) return false
    return (await this.helper.run(['slide', this.getHwnd(win), String(Math.round(offset))])).code === 0
  }

  /** 창 전체 투명도(0~255). null이면 layered 속성을 떼어 원래대로 되돌린다(아크릴 유지). */
  public static async setAlpha(win: BrowserWindow, alpha: number | null): Promise<boolean> {
    if (process.platform !== 'win32' || !win || win.isDestroyed() || !fs.existsSync(this.getDockerPath())) return false
    return (await this.helper.run(['fade', this.getHwnd(win), alpha === null ? 'off' : String(Math.max(0, Math.min(255, Math.round(alpha))))])).code === 0
  }

  /** Windows 11은 활성 창에만 아크릴 흐림을 그리므로 비활성 창도 활성처럼 그리게 한다. */
  public static keepBackdropActive(win: BrowserWindow): void {
    if (process.platform !== 'win32' || !win || win.isDestroyed() || !fs.existsSync(this.getDockerPath())) return
    void this.helper.run(['ncactivate', this.getHwnd(win)])
  }

  /**
   * 플로팅 모드 전용: staytop 프로세스 기동 (도킹 모드에서는 절대 실행하지 않음)
   */
  public static startStayTop(win: BrowserWindow, config?: WidgetConfig): void {
    if (!win || win.isDestroyed()) return
    this.stopStayTop()

    // docked 모드인 경우 실행 거부
    if (config?.placementMode === 'docked') {
      console.log('[TaskbarDocker] Skipping staytop: widget is in native docked mode')
      return
    }

    const exe = this.getDockerPath()
    if (!fs.existsSync(exe)) {
      console.warn('[TaskbarDocker] Docker executable not found for staytop:', exe)
      return
    }

    const hwnd = this.getHwnd(win)
    console.log(`[TaskbarDocker] Starting floating staytop for HWND ${hwnd}...`)

    try {
      this.stayTopProcess = spawn(exe, ['staytop', hwnd, '600'], {
        detached: false,
        stdio: 'ignore',
        windowsHide: true
      })

      this.stayTopProcess.on('error', (err) => {
        console.warn('[TaskbarDocker] staytop process error:', err)
      })

      win.once('closed', () => {
        this.stopStayTop()
      })
    } catch (err) {
      console.error('[TaskbarDocker] Failed to spawn staytop:', err)
    }
  }

  public static stopStayTop(): void {
    if (this.stayTopProcess) {
      try {
        this.stayTopProcess.kill()
      } catch {}
      this.stayTopProcess = null
    }
  }

  /**
   * 전체화면(게임/영상) 감지를 위한 상주 워처 프로세스 (플로팅 모드 전용)
   */
  public static startFullscreenWatcher(widgetWin: BrowserWindow, onChange: (isFullscreen: boolean) => void): void {
    this.stopFullscreenWatcher()

    const exe = this.getDockerPath()
    if (!fs.existsSync(exe)) {
      console.warn('[TaskbarDocker] Docker executable not found for fswatch:', exe)
      return
    }

    try {
      const hwnd = (widgetWin && !widgetWin.isDestroyed()) ? this.getHwnd(widgetWin) : '0'
      this.fsWatchProcess = spawn(exe, ['fswatch', '1000', hwnd], { windowsHide: true })
      let buffer = ''
      this.fsWatchProcess.stdout?.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line === '1' || line === '0') {
            onChange(line === '1')
          }
        }
      })
      this.fsWatchProcess.on('error', (err) => {
        console.warn('[TaskbarDocker] fswatch process error:', err)
      })
    } catch (err) {
      console.error('[TaskbarDocker] Failed to spawn fswatch:', err)
    }
  }

  public static stopFullscreenWatcher(): void {
    if (this.fsWatchProcess) {
      try {
        this.fsWatchProcess.kill()
      } catch {}
      this.fsWatchProcess = null
    }
  }

  /**
   * 화면 및 작업표시줄 기준 절대 좌표 계산 (플로팅 모드용)
   */
  public static calculatePosition(
    config: WidgetConfig,
    width: number,
    height: number
  ): { x: number; y: number } {
    return calculateWidgetPosition(config, width, height)
  }

  /**
   * 위젯 위치 및 크기 즉각 적용 (플로팅 모드 전용)
   */
  public static applyBounds(
    win: BrowserWindow,
    config: WidgetConfig,
    width: number,
    height: number
  ): void {
    if (!win || win.isDestroyed()) return
    // [중요] docked 모드에서는 Electron setBounds가 native docked HWND를 이동하거나 resize하지 못하도록 차단
    if (config.placementMode !== 'floating') return

    const { x, y } = this.calculatePosition(config, width, height)
    win.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    })
  }
}
