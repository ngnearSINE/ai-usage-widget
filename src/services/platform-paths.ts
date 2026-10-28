import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * OS마다 다른 경로. Windows는 %APPDATA%·*.exe, Linux는 XDG 설정 폴더(~/.config)·확장자 없는 실행 파일.
 * 바탕화면에서 띄운 앱은 셸의 PATH를 다 물려받지 못할 수 있어, Linux에서는 흔한 사용자 설치 위치를 더 찾아본다.
 */
/** 앱 설정 폴더: Windows %APPDATA%, Linux $XDG_CONFIG_HOME 또는 ~/.config */
export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === 'win32') return env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
}

export const exeName = (name: string, platform = process.platform) => platform === 'win32' ? `${name}.exe` : name

/** 실행 파일을 찾을 폴더: PATH, 그다음 Linux 사용자 설치 위치(~/.local/bin, npm·bun·volta·nvm, /usr/local/bin 등). */
export function executableDirs(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean)
  if (platform !== 'win32') {
    const home = os.homedir()
    dirs.push(path.join(home, '.local', 'bin'), path.join(home, 'bin'), path.join(home, '.npm-global', 'bin'),
      path.join(home, '.bun', 'bin'), path.join(home, '.volta', 'bin'), '/usr/local/bin', '/usr/bin', '/snap/bin')
    try {
      const nvm = path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node')
      for (const v of fs.readdirSync(nvm).sort().reverse()) dirs.push(path.join(nvm, v, 'bin'))
    } catch { /* nvm이 없으면 건너뛴다 */ }
  }
  return [...new Set(dirs)]
}

/** 이름으로 실행 파일을 찾는다(Windows는 .exe를 붙임). extraDirs를 먼저 본다. */
export function findExecutable(name: string, extraDirs: string[] = []): string | null {
  for (const dir of [...extraDirs, ...executableDirs()]) {
    const candidate = path.join(dir, exeName(name))
    try { if (fs.statSync(candidate).isFile()) return candidate } catch { /* 없음 */ }
  }
  return null
}
