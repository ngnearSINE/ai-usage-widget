// 작업 표시줄 도우미(TaskbarDock.exe)는 Windows 전용이다. 다른 OS에서는 건너뛴다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

if (process.platform !== 'win32') {
  console.log('build:native: Windows가 아니라 TaskbarDock.exe를 건너뜁니다.')
  process.exit(0)
}
const src = path.join('native', 'TaskbarDock.cs'), out = path.join('native', 'TaskbarDock.exe')
// 소스가 바뀌지 않았으면 다시 컴파일하지 않는다.
if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
  console.log('build:native: TaskbarDock.exe가 최신이라 건너뜁니다.')
  process.exit(0)
}
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!fs.existsSync(csc)) throw new Error(`csc.exe를 찾지 못했습니다: ${csc}`)
// anycpu: x64·arm64 Windows 모두 .NET Framework가 그 CPU로 실행한다.
execFileSync(csc, ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', `/out:${out}`, src], { stdio: 'inherit' })
