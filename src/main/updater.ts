import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import updaterPkg from 'electron-updater'
import type { UpdateState } from '../common/types.js'
import { inNightlyWindow, msUntilNightly } from './updater-time.js'

/**
 * 자동 업데이트. GitHub Releases(ngnearSINE/ai-usage-widget)의 새 버전을 뒤에서 내려받고,
 * 앱을 다시 시작할 때(또는 사용자가 '다시 시작해 업데이트'를 누를 때) 설치한다.
 * Windows 설치판(NSIS)과 Linux AppImage에서만 동작한다. 휴대용 zip·deb·개발 실행·미리보기는 'unsupported'.
 */
const { autoUpdater } = updaterPkg
const CHECK_EVERY_MS = 6 * 3600e3
const FIRST_CHECK_MS = 30e3

export class Updater {
  state: UpdateState
  private timer: ReturnType<typeof setTimeout> | undefined
  private nightlyTimer: ReturnType<typeof setTimeout> | undefined
  private manual = false
  private auto = true
  private hour = 3

  constructor(private readonly opts: { preview: boolean; onChange: () => void; onReady: (version: string) => void; onError?: (message: string) => void }) {
    this.state = { status: this.supported() ? 'idle' : 'unsupported' }
    if (this.state.status === 'unsupported') return
    autoUpdater.autoDownload = true
    // 자동 업데이트가 꺼져 있으면 받아 두기만 하고, 사용자가 '업데이트'를 누를 때만 설치한다.
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }))
    autoUpdater.on('update-available', info => this.set({ status: 'downloading', version: info.version, percent: 0 }))
    autoUpdater.on('download-progress', p => this.set({ ...this.state, status: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest', checkedAt: new Date().toISOString() }))
    autoUpdater.on('update-downloaded', info => {
      this.set({ status: 'ready', version: info.version })
      // 새벽 확인에서 받은 것이면 그 자리에서 설치한다(사용 중에 갑자기 다시 시작하지 않도록 시간대 안에서만).
      if (this.auto && inNightlyWindow(new Date(), this.hour)) { this.install(); return }
      this.opts.onReady(info.version)
    })
    autoUpdater.on('error', err => {
      const message = err?.message?.includes('net::') || err?.message?.includes('ENOTFOUND') ? '인터넷에 연결할 수 없어요' : '업데이트를 확인하지 못했어요'
      this.set({ status: 'error', message, checkedAt: new Date().toISOString() })
      if (this.manual) this.opts.onError?.(message)
    })
  }

  /** 설치판(NSIS)인지: 설치 폴더에 제거 프로그램이 있다. */
  private supported() {
    if (this.opts.preview || !app.isPackaged) return false
    // Linux: AppImage만 스스로 바꿀 수 있다(deb은 apt·패키지 관리자로 업데이트).
    if (process.platform === 'linux') return !!process.env.APPIMAGE
    if (process.platform !== 'win32') return false
    const dir = path.dirname(app.getPath('exe'))
    return fs.existsSync(path.join(dir, `Uninstall ${app.getName()}.exe`)) || fs.readdirSync(dir).some(f => /^Uninstall .*\.exe$/i.test(f))
  }

  private set(next: UpdateState) { this.state = next; this.opts.onChange() }

  /** 자동 업데이트를 켜거나 끈다. 켜면 시작 30초 뒤와 6시간마다 확인해 받아 두고, 매일 새벽 3시에 설치하고 다시 시작한다. */
  schedule(enabled: boolean, hour = 3) {
    clearTimeout(this.timer); clearTimeout(this.nightlyTimer)
    this.auto = enabled
    this.hour = hour
    if (this.state.status === 'unsupported') return
    autoUpdater.autoInstallOnAppQuit = enabled
    if (!enabled) return
    const loop = (delay: number) => { this.timer = setTimeout(() => { void this.check(false); loop(CHECK_EVERY_MS) }, delay) }
    loop(FIRST_CHECK_MS)
    const nightly = () => {
      this.nightlyTimer = setTimeout(() => {
        // 잠자기에서 늦게 깨어난 경우 시간대를 벗어났으면 건너뛴다.
        if (inNightlyWindow(new Date(), this.hour)) {
          if (this.state.status === 'ready') this.install()
          else void this.check(false) // 받기를 마치면 update-downloaded에서 설치
        }
        nightly()
      }, Math.min(msUntilNightly(new Date(), this.hour), 2 ** 31 - 1))
    }
    nightly()
  }

  async check(manual = true) {
    if (this.state.status === 'unsupported' || this.state.status === 'downloading' || this.state.status === 'ready' || this.state.status === 'checking') return this.state
    this.manual = manual
    try { await autoUpdater.checkForUpdates() } catch { /* error 이벤트에서 처리 */ }
    return this.state
  }

  /** 받아 둔 새 버전을 설치하고 다시 시작한다. */
  install() {
    if (this.state.status !== 'ready') return false
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
    return true
  }
}
