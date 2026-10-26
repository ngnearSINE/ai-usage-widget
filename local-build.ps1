param([switch]$BuildOnly, [switch]$Preview, [switch]$Package)
$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$hasher = [Security.Cryptography.SHA256]::Create()
try { $projectKey = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($sourceRoot.ToLowerInvariant())))).Replace('-','').Substring(0,12).ToLowerInvariant() }
finally { $hasher.Dispose() }
$buildRoot = Join-Path $env:USERPROFILE ('.cache/ai-usage-widget/' + $projectKey)
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null

# 소스는 프로젝트에, 재생성 가능한 의존성과 빌드 결과는 host 로컬 캐시에 둔다.
$lockHasher = [Security.Cryptography.SHA256]::Create()
try { $lockHash = ([BitConverter]::ToString($lockHasher.ComputeHash([IO.File]::ReadAllBytes((Join-Path $sourceRoot 'package-lock.json'))))).Replace('-','') }
finally { $lockHasher.Dispose() }
$receipt = Join-Path $buildRoot 'dependency.sha256'
$needsInstall = !(Test-Path -LiteralPath (Join-Path $buildRoot 'node_modules/electron/dist/electron.exe'))
if (!(Test-Path -LiteralPath $receipt) -or (Get-Content -LiteralPath $receipt -Raw).Trim() -ne $lockHash) { $needsInstall = $true }
foreach ($entry in @('src','native','public','test','index.html','tsconfig.json','vite.config.ts','electron-builder.json','package.json','package-lock.json')) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $entry) -Destination $buildRoot -Recurse -Force
}
Push-Location -LiteralPath $buildRoot
$previousBuildTemp = $env:TEMP
$previousBuildTmp = $env:TMP
$buildTemp = Join-Path $buildRoot '.tmp'
New-Item -ItemType Directory -Path $buildTemp -Force | Out-Null
$env:TEMP = $buildTemp
$env:TMP = $buildTemp
try {
  if ($needsInstall) {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw '의존성을 설치하지 못했습니다.' }
    Set-Content -LiteralPath $receipt -Value $lockHash -Encoding Ascii
  }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw '빌드하지 못했습니다. 이 캐시에서 실행 중인 위젯이 있으면 트레이에서 종료한 뒤 다시 시도해 주세요.' }
  if ($Package) {
    & (Join-Path $buildRoot 'node_modules/.bin/electron-builder.cmd') --win --dir --config.win.signAndEditExecutable=false
    if ($LASTEXITCODE -ne 0) { throw '로컬 실행 패키지를 만들지 못했습니다.' }
    Write-Host (Join-Path $buildRoot 'dist-release/win-unpacked/AI Usage Widget.exe')
  } elseif (!$BuildOnly) {
    $arguments = @('"' + (Join-Path $buildRoot 'dist-electron/main.js') + '"')
    if ($Preview) { $arguments += '--preview' }
    Start-Process -FilePath (Join-Path $buildRoot 'node_modules/electron/dist/electron.exe') -ArgumentList $arguments -WorkingDirectory $buildRoot -WindowStyle Hidden
  }
  Write-Host ('로컬 빌드: ' + $buildRoot)
} finally { $env:TEMP = $previousBuildTemp; $env:TMP = $previousBuildTmp; Pop-Location }
