param([switch]$BuildOnly, [switch]$Preview, [switch]$Package, [switch]$Release)
$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$hasher = [Security.Cryptography.SHA256]::Create()
try { $projectKey = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($sourceRoot.ToLowerInvariant())))).Replace('-','').Substring(0,12).ToLowerInvariant() }
finally { $hasher.Dispose() }
$buildRoot = Join-Path $env:USERPROFILE ('.cache/ai-usage-widget/' + $projectKey)
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null

# 배포: 버전 마지막 자리를 1 올린다. package.json과 package-lock.json의 앱 버전만 바꾼다.
if ($Release) {
  $bump = @'
const fs = require('fs'), path = require('path'), root = process.argv[2]
const pj = path.join(root, 'package.json'), pl = path.join(root, 'package-lock.json')
const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'))
if (process.argv[3]) pkg.version = process.argv[3]; else { const v = pkg.version.split('.').map(Number); v[2]++; pkg.version = v.join('.') }
fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + String.fromCharCode(10))
const lock = JSON.parse(fs.readFileSync(pl, 'utf8')); lock.version = pkg.version; if (lock.packages && lock.packages['']) lock.packages[''].version = pkg.version
fs.writeFileSync(pl, JSON.stringify(lock, null, 2) + String.fromCharCode(10))
console.log(pkg.version)
'@
  # PowerShell 5.1은 여러 줄 인자의 따옴표를 깨뜨리므로 임시 파일로 넘긴다.
  function Set-ReleaseVersion([string]$root, [string]$version) {
    $bumpFile = Join-Path ([IO.Path]::GetTempPath()) ('ai-usage-bump-' + [Guid]::NewGuid().ToString('N') + '.cjs')
    [IO.File]::WriteAllText($bumpFile, $bump)
    try { $v = (& node $bumpFile $root $version | Out-String).Trim() } finally { [IO.File]::Delete($bumpFile) }
    if ($LASTEXITCODE -ne 0 -or !$v) { throw '버전을 정하지 못했습니다.' }
    return $v
  }
}

# 소스는 프로젝트에, 재생성 가능한 의존성과 빌드 결과는 host 로컬 캐시에 둔다.
# 의존성 재설치 판단에는 앱 버전 필드를 빼고 잰다(배포마다 버전이 바뀌어도 다시 설치하지 않게).
$hashFile = Join-Path ([IO.Path]::GetTempPath()) ('ai-usage-lockhash-' + [Guid]::NewGuid().ToString('N') + '.cjs')
[IO.File]::WriteAllText($hashFile, "const c=require('crypto'),l=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));delete l.version;if(l.packages&&l.packages[''])delete l.packages[''].version;process.stdout.write(c.createHash('sha256').update(JSON.stringify(l)).digest('hex'))")
try { $lockHash = (& node $hashFile (Join-Path $sourceRoot 'package-lock.json') | Out-String).Trim() } finally { [IO.File]::Delete($hashFile) }
if ($LASTEXITCODE -ne 0 -or !$lockHash) { throw '의존성 목록을 읽지 못했습니다.' }
$receipt = Join-Path $buildRoot 'dependency.sha256'
$needsInstall = !(Test-Path -LiteralPath (Join-Path $buildRoot 'node_modules/electron/dist/electron.exe'))
if (!(Test-Path -LiteralPath $receipt) -or (Get-Content -LiteralPath $receipt -Raw).Trim() -ne $lockHash) { $needsInstall = $true }
foreach ($entry in @('src','native','public','test','index.html','tsconfig.json','vite.config.ts','electron-builder.json','package.json','package-lock.json','CHANGELOG.md')) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $entry) -Destination $buildRoot -Recurse -Force
}
# 사용 설명서 PDF는 배포본(설치 폴더·zip)에 '사용 설명서.pdf'로 들어간다(electron-builder.json extraFiles).
$guidePdf = Join-Path $sourceRoot 'docs/user-guide.pdf'
if (Test-Path -LiteralPath $guidePdf) {
  New-Item -ItemType Directory -Force -Path (Join-Path $buildRoot 'docs') | Out-Null
  Copy-Item -LiteralPath $guidePdf -Destination (Join-Path $buildRoot 'docs/user-guide.pdf') -Force
  if ((Get-Item -LiteralPath $guidePdf).LastWriteTime -lt (Get-Item -LiteralPath (Join-Path $sourceRoot 'docs/user-guide.md')).LastWriteTime) { Write-Warning '사용 설명서 PDF가 user-guide.md보다 오래되었습니다. PDF를 다시 만드세요.' }
} elseif ($Release -or $Package) { throw 'docs/user-guide.pdf가 없습니다. 배포본에 넣을 사용 설명서 PDF를 먼저 만드세요.' }
if ($Release) {
  # 새 버전은 빌드 캐시 사본에서만 먼저 쓰고, 배포본이 다 만들어진 뒤에 프로젝트 파일에 반영한다.
  $releaseVersion = Set-ReleaseVersion $buildRoot ''
  Write-Host ('배포 버전: ' + $releaseVersion)
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
  for ($try = 1; $try -le 4; $try++) {
    $buildLog = (& npm.cmd run build 2>&1 | Out-String)
    Write-Host $buildLog
    if ($LASTEXITCODE -eq 0 -or $buildLog -notmatch 'CVT1108') { break }
    Write-Warning ('C# 컴파일 임시 파일 오류(CVT1108) — 다시 시도합니다(' + $try + '/4)')
    Start-Sleep -Seconds 5
  }
  if ($LASTEXITCODE -ne 0) { throw '빌드하지 못했습니다. 이 캐시에서 실행 중인 위젯이 있으면 트레이에서 종료한 뒤 다시 시도해 주세요.' }
  if ($Release) {
    # 테스트가 실패하면 배포본을 만들지 않는다.
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw '테스트가 실패해 배포본을 만들지 않았습니다.' }
    $out = Join-Path $buildRoot 'dist-release'
    if (Test-Path -LiteralPath $out) { Get-ChildItem -LiteralPath $out -File | Where-Object { $_.Name -like 'AI Usage Widget*' } | Remove-Item -Force }
    $builder = Join-Path $buildRoot 'node_modules/.bin/electron-builder.cmd'
    & $builder --win --publish never
    if ($LASTEXITCODE -ne 0) {
      # 실행 파일 정보·아이콘 편집 도구(winCodeSign)는 심볼릭 링크 권한이 없으면 풀리지 않는다. 그때는 편집 없이 만든다.
      Write-Warning '실행 파일 아이콘·정보 편집에 실패해 편집 없이 다시 만듭니다.'
      & $builder --win --publish never --config.win.signAndEditExecutable=false
      if ($LASTEXITCODE -ne 0) { throw '배포본을 만들지 못했습니다.' }
    }
    $artifacts = @(Get-ChildItem -LiteralPath $out -File | Where-Object { $_.Name -like ('AI Usage Widget*' + $releaseVersion + '*') -and $_.Extension -in '.exe', '.zip' })
    if ($artifacts.Count -lt 2) { throw '설치 파일·압축본을 찾지 못했습니다.' }
    # 프로젝트 release/에는 최신 배포본만 둔다. 이 명령이 만든 이름의 파일만 지운다.
    $releaseDir = Join-Path $sourceRoot 'release'
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
    Get-ChildItem -LiteralPath $releaseDir -File | Where-Object { $_.Name -like 'AI Usage Widget*' -and $_.Extension -in '.exe', '.zip' } | Remove-Item -Force
    foreach ($a in $artifacts) { Copy-Item -LiteralPath $a.FullName -Destination $releaseDir -Force; Write-Host ('배포본: ' + (Join-Path $releaseDir $a.Name)) }
    # 성공했을 때만 프로젝트의 버전 파일을 새 버전으로 맞춘다.
    Set-ReleaseVersion $sourceRoot $releaseVersion | Out-Null
  } elseif ($Package) {
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
