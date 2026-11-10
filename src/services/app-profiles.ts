import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { appDataDir } from './platform-paths.js'
import type { ProfileApp, ProfileInfo, ProfileLearned, ProfileSource } from '../common/types.js'

/**
 * 데스크톱 앱 프로필(다른 데이터 폴더) 찾기.
 *
 * Electron·Chromium 앱은 `--user-data-dir=<폴더>`로 계정마다 다른 데이터 폴더를 쓸 수 있고, 여러 계정을 띄우는
 * 도구·바로가기도 이 방법을 쓴다. 폴더 이름은 도구마다 달라서 이름이 아니라 폴더 안의 로그인 흔적(서명)으로 어느 앱인지 판별한다.
 *
 * 찾는 곳
 * - default: 앱 기본 폴더(Windows Store 판은 패키지 안으로 바뀐 경로도)
 * - sibling: 기본 폴더 옆의 '<앱 폴더 이름>-…' 폴더(같은 이름 규칙으로 만든 두 번째 계정)
 * - running: 실행 중인 프로그램의 명령줄에 있던 `--user-data-dir`(한 번 본 폴더는 기억해 앱을 꺼도 계속 조회)
 * - deep: '깊게 찾기'로 사용자 폴더를 훑어 찾은 폴더(기억)
 * - added: 사용자가 고른 폴더. 프로필 폴더 자체이거나, 프로필을 담은 상위 폴더(아래 두 단계까지 살핀다)
 */

interface Signature {
  app: ProfileApp
  /** 앱 기본 데이터 폴더 이름. 형제 폴더('<이름>-…')와 기본 위치를 찾는 데 쓴다 */
  folder: string
  /** Windows Store 패키지 이름. 이 패키지의 앱은 AppData 쓰기가 패키지 안 LocalCache로 옮겨진다 */
  storePackage?: RegExp
  /** 이 폴더가 로그인된 이 앱의 프로필인가 */
  matches(dir: string, platform: NodeJS.Platform): boolean
}

const isFile = (p: string) => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p: string) => { try { return fs.statSync(p).isDirectory() } catch { return false } }

/** 작은 텍스트 파일 앞부분에 문자열이 있는지(큰 파일은 읽지 않는다). */
function fileIncludes(file: string, needle: string, maxBytes = 4 * 1024 * 1024): boolean {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > maxBytes) return false
    return fs.readFileSync(file, 'utf8').includes(needle)
  } catch { return false }
}

/** 판별 결과를 파일 변경 시각·크기로 기억한다(Cursor 상태 DB는 수백 MB라 매번 읽지 않는다). */
const memo = new Map<string, { key: string; value: boolean }>()
function memoBy(id: string, files: string[], compute: () => boolean): boolean {
  const key = files.map(f => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}` } catch { return '-' } }).join('|')
  const hit = memo.get(id)
  if (hit && hit.key === key) return hit.value
  const value = compute()
  memo.set(id, { key, value })
  return value
}

export const SIGNATURES: Signature[] = [
  {
    app: 'claude', folder: 'Claude', storePackage: /^Claude_/i,
    // config.json의 oauth:tokenCacheV2 = 로그인한 Claude 데스크톱 앱. Windows는 그 암호화 키가 Local State에 있다.
    matches: (dir, platform) => (platform !== 'win32' || isFile(path.join(dir, 'Local State')))
      && memoBy(`claude:${dir}`, [path.join(dir, 'config.json')], () => fileIncludes(path.join(dir, 'config.json'), '"oauth:tokenCacheV2"')),
  },
  {
    app: 'cursor', folder: 'Cursor',
    // VS Code 계열은 폴더 구조가 같아서 Cursor 내장 확장(anysphere.*)의 저장 폴더나 폴더 이름으로 가린다.
    // 상태 DB(수백 MB)는 여기서 읽지 않는다. 로그인 여부는 Cursor 카드가 있을 때만 cursor-client가 읽는다.
    matches: dir => {
      const gs = path.join(dir, 'User', 'globalStorage')
      if (!isFile(path.join(gs, 'state.vscdb'))) return false
      if (/cursor/i.test(path.basename(dir))) return true
      return memoBy(`cursor:${dir}`, [gs], () => { try { return fs.readdirSync(gs).some(n => /^anysphere\./i.test(n)) } catch { return false } })
    },
  },
]
const signature = (app: ProfileApp) => SIGNATURES.find(s => s.app === app)!

/** 경로 비교용 열쇠: 절대 경로, 끝의 구분자 없음, Windows는 대소문자 무시. */
export function pathKey(p: string, platform = process.platform): string {
  const r = path.resolve(p).replace(/[\\/]+$/, '')
  return platform === 'win32' ? r.toLowerCase() : r
}

/** Windows Store 앱 패키지 폴더 중 서명의 패키지 이름에 맞는 것. */
function storePackages(sig: Signature, env: NodeJS.ProcessEnv): string[] {
  if (!sig.storePackage || !env.LOCALAPPDATA) return []
  const root = path.join(env.LOCALAPPDATA, 'Packages')
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && sig.storePackage!.test(e.name)).map(e => path.join(root, e.name)) } catch { return [] }
}

/**
 * Store 앱이 AppData에 쓰려던 폴더가 실제로 놓이는 곳. 앱에 '%APPDATA%\X'를 주면 패키지 안
 * 'LocalCache\Roaming\X'에 쓰인다. AppData 밖의 폴더는 그대로 쓰이므로 바뀐 경로가 없다.
 */
export function storeRedirects(dir: string, sig: Signature, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  if (platform !== 'win32') return []
  const roaming = env.APPDATA, local = env.LOCALAPPDATA
  const under = (base: string | undefined) => {
    if (!base) return null
    const rel = path.relative(base, dir)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null
  }
  const rRoam = under(roaming), rLocal = under(local)
  if (rLocal && /^packages[\\/]/i.test(rLocal)) return []
  return storePackages(sig, env).flatMap(pkg => [
    ...(rRoam ? [path.join(pkg, 'LocalCache', 'Roaming', rRoam)] : []),
    ...(rLocal ? [path.join(pkg, 'LocalCache', 'Local', rLocal)] : []),
  ])
}

/** 앱 기본 데이터 폴더(있든 없든). */
export function defaultDirs(sig: Signature, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const base = platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : appDataDir(env, platform)
  const main = path.join(base, sig.folder)
  return [main, ...storePackages(sig, env).map(pkg => path.join(pkg, 'LocalCache', 'Roaming', sig.folder))]
}

/** 기본 폴더 옆의 '<앱 폴더 이름>-…'·'<이름>_…'·'<이름> …' 폴더. */
export function siblingDirs(sig: Signature, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const pattern = new RegExp(`^${sig.folder}[-_ .].+`, 'i')
  const out: string[] = []
  for (const parent of new Set(defaultDirs(sig, env, platform).map(d => path.dirname(d)))) {
    try { for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isDirectory() && pattern.test(e.name)) out.push(path.join(parent, e.name)) } catch { /* 없음 */ }
  }
  return out
}

/**
 * 명령줄에서 `--user-data-dir` 값들을 꺼낸다. 아래 모양을 모두 받는다.
 * `--user-data-dir=C:\a`, `--user-data-dir="C:\a b"`, `"--user-data-dir=C:\a b"`, `--user-data-dir "C:\a b"`, `--user-data-dir C:\a`
 */
export function parseUserDataDirs(cmdline: string): string[] {
  const out: string[] = []
  const flag = '--user-data-dir'
  for (let i = cmdline.indexOf(flag); i >= 0; i = cmdline.indexOf(flag, i + flag.length)) {
    const quotedFlag = cmdline[i - 1] === '"'
    let j = i + flag.length
    if (cmdline[j] === '=') j++
    else if (/\s/.test(cmdline[j] || '')) { while (/\s/.test(cmdline[j] || '')) j++ }
    else continue // --user-data-dir-something 같은 다른 이름
    let value: string
    if (cmdline[j] === '"') { const end = cmdline.indexOf('"', j + 1); value = cmdline.slice(j + 1, end < 0 ? undefined : end) }
    else if (quotedFlag) { const end = cmdline.indexOf('"', j); value = cmdline.slice(j, end < 0 ? undefined : end) }
    else { const m = /^[^\s"]+/.exec(cmdline.slice(j)); value = m ? m[0] : '' }
    value = value.trim()
    if (value && path.isAbsolute(value)) out.push(value)
  }
  return out
}

/** 실행 중인 프로그램 명령줄들의 `--user-data-dir` 폴더. 실패하면 빈 목록. */
export function runningUserDataDirs(platform = process.platform): Promise<string[]> {
  if (platform === 'linux') {
    const out: string[] = []
    try {
      for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue
        try {
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          if (!cmd.includes('--user-data-dir')) continue
          const args = cmd.split('\0')
          args.forEach((a, k) => {
            if (a.startsWith('--user-data-dir=')) out.push(a.slice('--user-data-dir='.length))
            else if (a === '--user-data-dir' && args[k + 1]) out.push(args[k + 1])
          })
        } catch { /* 끝난 프로세스·권한 없음 */ }
      }
    } catch { /* /proc 없음 */ }
    return Promise.resolve(out.filter(d => path.isAbsolute(d)))
  }
  if (platform !== 'win32') return Promise.resolve([])
  // 명령줄만 한 줄씩 받는다(UTF-8로 한글 경로 보존). 다른 정보는 읽지 않는다.
  const script = `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8
    Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%--user-data-dir%'" | ForEach-Object { $_.CommandLine }`
  const exe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
  return new Promise(resolve => {
    let text = ''
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
    child.stdout.on('data', c => { text += c.toString('utf8'); if (text.length > 4e6) child.kill() })
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(text.split(/\r?\n/).flatMap(parseUserDataDirs)))
  })
}

// '깊게 찾기'에서 들어가지 않는 폴더: 크고 프로필이 있을 리 없는 곳.
const SKIP = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.npm', '.yarn', '.pnpm-store', '.cargo', '.rustup', '.gradle', '.m2', '.nuget',
  '.cache', 'cache', 'code cache', 'gpucache', 'dawncache', 'shadercache', 'grshadercache', 'service worker', 'indexeddb', 'local storage', 'session storage',
  'blob_storage', 'crashpad', 'logs', 'site-packages', 'venv', '.venv', 'env', 'extensions', 'workspacestorage', 'history', 'snapshots', 'appdata', 'library',
  'windows', 'program files', 'program files (x86)', '$recycle.bin', 'dropbox', 'onedrive', 'google drive', 'icloud drive', 'pictures', 'videos', 'music'])

/** 폴더 아래에서 서명에 맞는 프로필을 찾는다(깊이·개수·시간 제한). 프로필을 찾으면 그 안으로는 더 들어가지 않는다. */
export async function scanTree(root: string, maxDepth: number, budget = { dirs: 30_000, until: Date.now() + 15_000 }, platform = process.platform): Promise<Array<{ app: ProfileApp; dir: string }>> {
  const found: Array<{ app: ProfileApp; dir: string }> = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (queue.length && budget.dirs > 0 && Date.now() < budget.until) {
    const { dir, depth } = queue.shift()!
    budget.dirs--
    const sig = classify(dir, platform)
    if (sig) { found.push({ app: sig, dir }); continue }
    if (depth >= maxDepth) continue
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      // 바로가기(심볼릭 링크·정션)는 따라가지 않는다(같은 곳을 두 번 돌거나 끝없이 도는 것을 막는다).
      if (!e.isDirectory() || e.isSymbolicLink() || SKIP.has(e.name.toLowerCase())) continue
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 })
    }
  }
  return found
}

/** 이 폴더가 어느 앱의 로그인된 프로필인지(없으면 null). */
export function classify(dir: string, platform = process.platform): ProfileApp | null {
  for (const sig of SIGNATURES) if (sig.matches(dir, platform)) return sig.app
  return null
}

/** 사용자가 고른 폴더 하나를 살핀다: 프로필 자체 / 프로필을 담은 상위 폴더 / 해당 없음. */
export async function inspectProfileFolder(dir: string, platform = process.platform): Promise<{ kind: 'profile'; app: ProfileApp } | { kind: 'parent'; apps: Partial<Record<ProfileApp, number>> } | { kind: 'none' }> {
  const app = classify(dir, platform)
  if (app) return { kind: 'profile', app }
  const found = await scanTree(dir, 2, { dirs: 5000, until: Date.now() + 5000 }, platform)
  if (!found.length) return { kind: 'none' }
  const apps: Partial<Record<ProfileApp, number>> = {}
  for (const f of found) apps[f.app] = (apps[f.app] || 0) + 1
  return { kind: 'parent', apps }
}

export interface ProfileOptions { added: string[]; excluded: string[]; learned: ProfileLearned[]; scanProcesses: boolean }
const MAX_LEARNED = 64
// 브라우저·WebView2가 쓰는 데이터 폴더(Chrome·Edge 'User Data', 앱에 들어 있는 'EBWebView')는 기억하지 않는다.
const BROWSER_DATA = /^(user data|ebwebview)$/i
const PROCESS_SCAN_MS = 2 * 60e3
const LIST_TTL_MS = 5e3

export class AppProfiles {
  private static opts: ProfileOptions = { added: [], excluded: [], learned: [], scanProcesses: true }
  private static lastProcessScan = 0
  private static pending: Promise<ProfileLearned[] | null> | null = null
  private static cache: { at: number; list: ProfileInfo[] } | null = null
  /** 사용자 폴더가 '추가한 상위 폴더'이면 그 아래에서 찾은 프로필(폴더마다 기억, 다시 찾기·추가 때 새로 고침). */
  private static addedFound = new Map<string, Array<{ app: ProfileApp; dir: string }>>()

  /** 설정에서 읽은 값으로 맞춘다. 바뀐 게 있으면 다음 목록을 새로 만든다. */
  static configure(opts: Partial<ProfileOptions>) {
    const next = { ...this.opts, ...opts }
    if (JSON.stringify(next) !== JSON.stringify(this.opts)) this.cache = null
    this.opts = next
  }

  /**
   * 실행 중인 프로그램을 살펴 새 `--user-data-dir`를 기억하고, 사라진 폴더는 잊는다. 기억 목록이 바뀌었으면 새 목록을, 아니면 null.
   * 프로그램 살피기는 2분에 한 번(force면 바로). 추가한 상위 폴더도 이때 다시 훑는다.
   */
  static refresh(force = false): Promise<ProfileLearned[] | null> {
    this.pending ||= this.doRefresh(force).finally(() => { this.pending = null })
    return this.pending
  }

  private static async doRefresh(force: boolean): Promise<ProfileLearned[] | null> {
    const before = JSON.stringify(this.opts.learned)
    let learned = this.opts.learned.filter(l => isDir(l.dir))
    const due = force || Date.now() - this.lastProcessScan >= PROCESS_SCAN_MS
    if (due) {
      this.lastProcessScan = Date.now()
      await this.rescanAdded()
      if (this.opts.scanProcesses) {
        const now = new Date().toISOString()
        // 로그인 전에 본 폴더도 기억해 둔다(실행 중에 로그인하고 앱을 바로 꺼도 나중에 찾도록). 판별은 목록을 만들 때 한다.
        for (const dir of await runningUserDataDirs()) {
          if (BROWSER_DATA.test(path.basename(dir))) continue
          // 이미 아는 폴더는 그대로 둔다(매번 설정 파일을 다시 쓰지 않게). 새 폴더만 앞에 더한다.
          const k = pathKey(dir)
          if (!learned.some(l => pathKey(l.dir) === k)) learned = [{ dir, via: 'running', seenAt: now }, ...learned]
        }
      }
    }
    learned = learned.slice(0, MAX_LEARNED)
    if (JSON.stringify(learned) === before) return null
    this.opts = { ...this.opts, learned }
    this.cache = null
    return learned
  }

  private static async rescanAdded() {
    const next = new Map<string, Array<{ app: ProfileApp; dir: string }>>()
    for (const dir of this.opts.added) {
      if (!isDir(dir)) continue
      const app = classify(dir)
      next.set(pathKey(dir), app ? [{ app, dir }] : await scanTree(dir, 2, { dirs: 5000, until: Date.now() + 5000 }))
    }
    this.addedFound = next
    this.cache = null
  }

  /** 사용자 폴더 전체를 훑어 찾은 프로필을 기억 목록에 더한다. 새로 찾은 수와 새 기억 목록. */
  static async deepScan(platform = process.platform): Promise<{ added: number; learned: ProfileLearned[] }> {
    const home = os.homedir()
    const budget = { dirs: 40_000, until: Date.now() + 20_000 }
    const roots: Array<[string, number]> = [[home, 4]]
    if (platform === 'win32') {
      for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) if (base) roots.push([base, 2])
      for (const sig of SIGNATURES) for (const pkg of storePackages(sig, process.env)) roots.push([path.join(pkg, 'LocalCache'), 3])
    } else if (platform === 'linux') roots.push([appDataDir(process.env, platform), 2])
    const found: Array<{ app: ProfileApp; dir: string }> = []
    for (const [root, depth] of roots) found.push(...await scanTree(root, depth, budget, platform))
    const known = new Set(this.list(undefined, true).map(p => pathKey(p.dir)))
    const now = new Date().toISOString()
    const fresh = found.filter(f => !known.has(pathKey(f.dir)))
    const uniq = [...new Map(fresh.map(f => [pathKey(f.dir), f])).values()]
    const learned = [...uniq.map(f => ({ dir: f.dir, via: 'deep' as const, seenAt: now })), ...this.opts.learned].slice(0, MAX_LEARNED)
    this.opts = { ...this.opts, learned }
    this.cache = null
    return { added: uniq.length, learned }
  }

  /** 찾은 프로필 목록. app을 주면 그 앱만, withExcluded면 제외한 것도(설정 화면용). */
  static list(app?: ProfileApp, withExcluded = false): ProfileInfo[] {
    if (!this.cache || Date.now() - this.cache.at > LIST_TTL_MS) this.cache = { at: Date.now(), list: this.build() }
    return this.cache.list.filter(p => (!app || p.app === app) && (withExcluded || !p.excluded))
  }

  /** 이 폴더 아래(Store 앱이 옮겨 쓴 자리 포함)에서 찾은 프로필. 제외한 것도 포함. */
  static under(root: string, platform = process.platform): ProfileInfo[] {
    const roots = [root, ...SIGNATURES.flatMap(s => storeRedirects(root, s, process.env, platform))].map(r => pathKey(r, platform))
    return this.list(undefined, true).filter(p => { const k = pathKey(p.dir, platform); return roots.some(r => k === r || k.startsWith(r + path.sep)) })
  }

  /** 프로필 폴더들(제외한 것 빼고). */
  static dirs(app: ProfileApp): string[] { return this.list(app).map(p => p.dir) }

  private static build(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ProfileInfo[] {
    const out = new Map<string, ProfileInfo>()
    const excluded = new Set(this.opts.excluded.map(d => pathKey(d, platform)))
    const add = (app: ProfileApp, dir: string, source: ProfileSource) => {
      const k = pathKey(dir, platform)
      if (out.has(k)) return
      out.set(k, { app, dir, source, excluded: excluded.has(k) })
    }
    // 폴더 하나를 보고, 맞지 않으면 Store 앱이 옮겨 쓴 자리도 본다.
    const probe = (dir: string, source: ProfileSource, only?: ProfileApp) => {
      for (const sig of SIGNATURES) {
        if (only && sig.app !== only) continue
        for (const d of [dir, ...storeRedirects(dir, sig, env, platform)]) if (sig.matches(d, platform)) add(sig.app, d, source)
      }
    }
    for (const sig of SIGNATURES) {
      for (const d of defaultDirs(sig, env, platform)) if (sig.matches(d, platform)) add(sig.app, d, 'default')
      for (const d of siblingDirs(sig, env, platform)) if (sig.matches(d, platform)) add(sig.app, d, 'sibling')
    }
    for (const found of this.addedFound.values()) for (const f of found) probe(f.dir, 'added', f.app)
    for (const dir of this.opts.added) probe(dir, 'added')
    for (const l of this.opts.learned) probe(l.dir, l.via)
    return [...out.values()]
  }

  /** 시험용: 상태를 처음으로 되돌린다. */
  static reset() { this.opts = { added: [], excluded: [], learned: [], scanProcesses: true }; this.cache = null; this.addedFound.clear(); this.lastProcessScan = 0; memo.clear() }
}
