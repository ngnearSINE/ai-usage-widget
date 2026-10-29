import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AccountConfig } from '../common/types.js'
import { executableDirs } from '../services/platform-paths.js'

/**
 * 카드에서 그 서비스의 CLI(기본 터미널에서)나 데스크톱 앱을 바로 연다.
 * CLI는 PATH·사용자 설치 위치에서, 앱은 Windows 시작 메뉴 앱 목록(Get-StartApps)이나 Linux .desktop 파일에서 찾는다.
 * Chrome 등에 설치한 웹앱(PWA)은 진짜 앱이 아니므로 빼고, 못 찾으면 메뉴를 흐리게 둔다.
 */
const CLI: Record<string, string> = { claude: 'claude', codex: 'codex', xai: 'grok', antigravity: 'agy', cursor: 'cursor-agent', copilot: 'copilot', google: 'gemini' }
type AppMatch = (name: string, id: string) => boolean
const notPwa = (id: string) => !/^Chrome\._crx_|^MSEdge\._crx_|_crx_/i.test(id)
const APP: Record<string, AppMatch> = {
  claude: (n, id) => notPwa(id) && (/^Claude_/i.test(id) || /^claude$/i.test(n) || /claude-desktop/i.test(id)),
  codex: (n, id) => notPwa(id) && (/OpenAI\.Codex/i.test(id) || /^codex$/i.test(n)),
  xai: (n, id) => notPwa(id) && /^grok/i.test(n),
  antigravity: (n, id) => notPwa(id) && /antigravity/i.test(n),
  cursor: (n, id) => notPwa(id) && /^cursor$/i.test(n),
}

/** 앱 목록의 한 항목(이름·앱 ID)이 이 서비스의 데스크톱 앱인지. */
export const appMatches = (provider: string, name: string, id: string) => !!APP[provider]?.(name, id)

/** 이 계정의 CLI 실행 파일(없으면 null). Windows는 .exe·.cmd(npm)도 본다. */
export function findCli(provider: string): string | null {
  const name = CLI[provider]
  if (!name) return null
  const extra = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.grok', 'bin')]
  if (process.env.LOCALAPPDATA) extra.push(path.join(process.env.LOCALAPPDATA, 'agy', 'bin'))
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  for (const dir of [...executableDirs(), ...extra]) for (const ext of exts) {
    const p = path.join(dir, name + ext)
    try { if (fs.statSync(p).isFile()) return p } catch { /* 없음 */ }
  }
  return null
}

interface AppEntry { name: string; id: string }
let appCache: { at: number; list: AppEntry[] } | null = null
let appLoading: Promise<AppEntry[]> | null = null

/** 설치된 앱 목록(10분 동안 기억). Windows: Get-StartApps, Linux: .desktop 파일. */
function installedApps(): Promise<AppEntry[]> {
  if (appCache && Date.now() - appCache.at < 10 * 60e3) return Promise.resolve(appCache.list)
  appLoading ||= (process.platform === 'win32' ? windowsApps() : Promise.resolve(linuxApps()))
    .then(list => { appCache = { at: Date.now(), list }; return list })
    .catch(() => appCache?.list || [])
    .finally(() => { appLoading = null })
  return appLoading
}
function windowsApps(): Promise<AppEntry[]> {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 15000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return resolve([])
      try {
        const j = JSON.parse(String(out) || '[]'), arr = Array.isArray(j) ? j : [j]
        resolve(arr.filter(a => a?.Name && a?.AppID).map(a => ({ name: String(a.Name), id: String(a.AppID) })))
      } catch { resolve([]) }
    })
  })
}
function linuxApps(): AppEntry[] {
  const dirs = [path.join(os.homedir(), '.local/share/applications'), '/usr/share/applications', '/usr/local/share/applications', '/var/lib/snapd/desktop/applications']
  const out: AppEntry[] = []
  for (const dir of dirs) {
    let files: string[] = []
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.desktop')) } catch { continue }
    for (const f of files) {
      try {
        const name = /^Name=(.+)$/m.exec(fs.readFileSync(path.join(dir, f), 'utf8'))?.[1]?.trim()
        if (name) out.push({ name, id: f.replace(/\.desktop$/, '') })
      } catch { /* 건너뜀 */ }
    }
  }
  return out
}

/** 이 서비스의 데스크톱 앱(없으면 null). */
export async function findApp(provider: string): Promise<AppEntry | null> {
  const match = APP[provider]
  if (!match) return null
  return (await installedApps()).find(a => match(a.name, a.id)) || null
}

/** 메뉴를 빨리 띄우려고 미리 앱 목록을 읽어 둔다. */
export function warmLaunchers() { void installedApps() }

/** CLI를 기본 터미널에서 실행한 채로 연다. 두 번째 계정은 그 로그인 폴더(CODEX_HOME·GROK_HOME·CLAUDE_CONFIG_DIR)로. */
export function openCli(acc: AccountConfig): boolean {
  const exe = acc.launchCli && fs.existsSync(acc.launchCli) ? acc.launchCli : findCli(acc.provider)
  if (!exe) return false
  const env = { ...process.env }
  if (acc.homeDir && acc.provider === 'codex') env.CODEX_HOME = acc.homeDir
  if (acc.homeDir && acc.provider === 'xai') env.GROK_HOME = acc.homeDir
  if (acc.homeDir && acc.provider === 'claude') env.CLAUDE_CONFIG_DIR = acc.homeDir
  // 시작 폴더: 직접 고른 폴더가 있으면 그곳, 없으면 홈 폴더
  const cwd = acc.launchCwd && fs.existsSync(acc.launchCwd) && fs.statSync(acc.launchCwd).isDirectory() ? acc.launchCwd : os.homedir()
  const opts = { cwd, env, detached: true, stdio: 'ignore' as const }
  if (process.platform === 'win32') {
    // start로 새 콘솔을 띄우면 Windows가 기본 터미널(Windows Terminal 등)로 연다. /k: CLI가 끝나도 창은 남는다.
    spawn('cmd.exe', ['/d', '/c', 'start', '""', 'cmd.exe', '/k', `"${exe}"`], { ...opts, windowsHide: true, windowsVerbatimArguments: true }).unref()
    return true
  }
  for (const [term, args] of [['x-terminal-emulator', ['-e', exe]], ['gnome-terminal', ['--', exe]], ['konsole', ['-e', exe]], ['xterm', ['-e', exe]]] as const) {
    if (executableDirs().some(d => fs.existsSync(path.join(d, term)))) { spawn(term, [...args], opts).unref(); return true }
  }
  return false
}

/** 데스크톱 앱을 실행한다. 직접 지정한 파일(.exe·바로 가기·.desktop·AppImage)이 있으면 그것을. */
export async function openApp(acc: AccountConfig): Promise<boolean> {
  if (acc.launchApp && fs.existsSync(acc.launchApp)) {
    const p = acc.launchApp
    if (process.platform === 'win32') spawn('cmd.exe', ['/d', '/c', 'start', '""', `"${p}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
    else if (p.endsWith('.desktop')) spawn('gtk-launch', [path.basename(p, '.desktop')], { detached: true, stdio: 'ignore' }).unref()
    else spawn(p, [], { detached: true, stdio: 'ignore' }).unref()
    return true
  }
  const provider = acc.provider
  const app = await findApp(provider)
  if (!app) return false
  if (process.platform === 'win32') spawn('explorer.exe', [`shell:AppsFolder\\${app.id}`], { detached: true, stdio: 'ignore' }).unref()
  else spawn('gtk-launch', [app.id], { detached: true, stdio: 'ignore' }).unref()
  return true
}
