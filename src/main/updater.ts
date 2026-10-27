import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import updaterPkg from 'electron-updater'
import type { UpdateState } from '../common/types.js'

/**
 * 자동 업데이트. GitHub Releases(ngnearSINE/ai-usage-widget)의 새 버전을 뒤에서 내려받고,
 * 앱을 다시 시작할 때(또는 사용자가 '다시 시작해 업데이트'를 누를 때) 설치한다.
 * 설치판에서만 동작한다. 휴대용 zip·개발 실행·미리보기는 설치 위치를 바꿀 수 없으므로 'unsupported'.
 */
const { autoUpdater } = updaterPkg
const CHECK_EVERY_MS = 6 * 3600e3
const FIRST_CHECK_MS = 30e3

export class Updater {
  state: UpdateState
  private timer: ReturnType<typeof setTimeout> | undefined
  private manual = false

  constructor(private readonly opts: { preview: boolean; onChange: () => void; onReady: (version: string) => void; onError?: (message: string) => void }) {
    this.state = { status: this.supported() ? 'idle' : 'unsupported' }
    if (this.state.status === 'unsupported') return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }))
    autoUpdater.on('update-available', info => this.set({ status: 'downloading', version: info.version, percent: 0 }))
    autoUpdater.on('download-progress', p => this.set({ ...this.state, status: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest', checkedAt: new Date().toISOString() }))
    autoUpdater.on('update-downloaded', info => { this.set({ status: 'ready', version: info.version }); this.opts.onReady(info.version) })
    autoUpdater.on('error', err => {
      const message = err?.message?.includes('net::') || err?.message?.includes('ENOTFOUND') ? '인터넷에 연결할 수 없어요' : '업데이트를 확인하지 못했어요'
      this.set({ status: 'error', message, checkedAt: new Date().toISOString() })
      if (this.manual) this.opts.onError?.(message)
    })
  }

  /** 설치판(NSIS)인지: 설치 폴더에 제거 프로그램이 있다. */
  private supported() {
    if (this.opts.preview || !app.isPackaged || process.platform !== 'win32') return false
    const dir = path.dirname(app.getPath('exe'))
    return fs.existsSync(path.join(dir, `Uninstall ${app.getName()}.exe`)) || fs.readdirSync(dir).some(f => /^Uninstall .*\.exe$/i.test(f))
  }

  private set(next: UpdateState) { this.state = next; this.opts.onChange() }

  /** 자동 확인을 켜거나 끈다. 켜면 시작 30초 뒤와 6시간마다 확인한다. */
  schedule(enabled: boolean) {
    clearTimeout(this.timer)
    if (!enabled || this.state.status === 'unsupported') return
    const loop = (delay: number) => { this.timer = setTimeout(() => { void this.check(false); loop(CHECK_EVERY_MS) }, delay) }
    loop(FIRST_CHECK_MS)
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
