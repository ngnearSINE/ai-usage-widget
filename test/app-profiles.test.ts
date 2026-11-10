import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppProfiles, SIGNATURES, classify, inspectProfileFolder, parseUserDataDirs, pathKey, scanTree, siblingDirs, storeRedirects } from '../src/services/app-profiles.js'
import { cursorUsers, readCursorToken } from '../src/services/cursor-client.js'
import { syncIdentityAccounts } from '../src/common/profile-account-sync.js'
import type { AccountConfig } from '../src/common/types.js'

const claude = SIGNATURES.find(s => s.app === 'claude')!

/** 로그인한 Claude 앱 프로필 폴더(config.json의 oauth:tokenCacheV2 + Local State)를 만든다. */
function claudeProfile(dir: string, loggedIn = true) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'Local State'), '{}')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(loggedIn ? { 'oauth:tokenCacheV2': 'djEw', lastKnownAccountUuid: 'a' } : { locale: 'ko' }))
}
const jwt = (sub: string, exp: number) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')}.c2ln`
/** 로그인한 Cursor 프로필 폴더(User/globalStorage/state.vscdb에 토큰·이메일). */
function cursorProfile(dir: string, user: string, email: string) {
  const gs = path.join(dir, 'User', 'globalStorage')
  fs.mkdirSync(path.join(gs, 'anysphere.cursor-retrieval'), { recursive: true })
  fs.writeFileSync(path.join(gs, 'state.vscdb'), Buffer.from(`junk cursorAuth/accessToken\x01${jwt(`auth0|${user}`, 4e9)} cursorAuth/cachedEmail${email}\x00tail`, 'latin1'))
}

/** 환경 변수를 바꿔 둔 채 (비동기) 실행하고 되돌린다. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k] }
  try { return await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('명령줄의 --user-data-dir 값을 여러 모양에서 꺼낸다', () => {
  assert.deepEqual(parseUserDataDirs('"C:\\Apps\\claude.exe" --user-data-dir=C:\\Users\\a\\.x\\profiles\\Claude-Work --flag'), ['C:\\Users\\a\\.x\\profiles\\Claude-Work'])
  assert.deepEqual(parseUserDataDirs('claude.exe --user-data-dir="C:\\My Profiles\\Claude Two" --x'), ['C:\\My Profiles\\Claude Two'])
  assert.deepEqual(parseUserDataDirs('claude.exe "--user-data-dir=C:\\My Profiles\\B" --x'), ['C:\\My Profiles\\B'])
  assert.deepEqual(parseUserDataDirs('cursor --user-data-dir /home/a/p --x'), ['/home/a/p'])
  assert.deepEqual(parseUserDataDirs('x --user-data-dir-extra=foo --user-data-dir=relative'), [], '다른 이름·상대 경로는 뺀다')
  assert.deepEqual(parseUserDataDirs('a --user-data-dir=/p/1 b --user-data-dir=/p/2'), ['/p/1', '/p/2'])
})

test('폴더 내용으로 앱을 판별한다(이름이 아니라 로그인 흔적)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-prof-'))
  try {
    claudeProfile(path.join(root, 'any-name'))
    claudeProfile(path.join(root, 'Claude-3p'), false)
    cursorProfile(path.join(root, 'cur'), 'user_A', 'a@x.io')
    fs.mkdirSync(path.join(root, 'vscode', 'User', 'globalStorage'), { recursive: true })
    fs.writeFileSync(path.join(root, 'vscode', 'User', 'globalStorage', 'state.vscdb'), 'no cursor here')
    assert.equal(classify(path.join(root, 'any-name')), 'claude')
    assert.equal(classify(path.join(root, 'Claude-3p')), null, '로그인 흔적 없는 Claude 변형 폴더')
    assert.equal(classify(path.join(root, 'cur')), 'cursor')
    assert.equal(classify(path.join(root, 'vscode')), null, '같은 구조의 VS Code 폴더')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('기본 폴더 옆의 같은 이름 폴더, Store 앱이 옮겨 쓴 자리', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-prof-'))
  try {
    const roaming = path.join(root, 'Roaming'), local = path.join(root, 'Local')
    for (const n of ['Claude', 'Claude-Account2', 'Claude Code', 'ClaudeX', 'Other']) fs.mkdirSync(path.join(roaming, n), { recursive: true })
    const env = { APPDATA: roaming, LOCALAPPDATA: local, XDG_CONFIG_HOME: roaming }
    const sib = siblingDirs(claude, env, 'win32').map(d => path.basename(d)).sort()
    assert.deepEqual(sib, ['Claude Code', 'Claude-Account2'])
    fs.mkdirSync(path.join(local, 'Packages', 'Claude_pzs8', 'LocalCache', 'Roaming'), { recursive: true })
    assert.deepEqual(storeRedirects(path.join(roaming, 'Claude-Account2'), claude, env, 'win32'),
      [path.join(local, 'Packages', 'Claude_pzs8', 'LocalCache', 'Roaming', 'Claude-Account2')])
    assert.deepEqual(storeRedirects(path.join(os.homedir(), '.tool', 'profiles', 'Claude-W'), claude, env, 'win32'), [], 'AppData 밖은 그대로 쓰인다')
    assert.deepEqual(storeRedirects(path.join(roaming, 'Claude-Account2'), claude, env, 'linux'), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('폴더 훑기: 깊이 제한, 무거운 폴더 건너뛰기, 프로필 안으로는 더 들어가지 않음', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-prof-'))
  try {
    claudeProfile(path.join(root, '.launcher', 'profiles', 'Claude-Work'))
    claudeProfile(path.join(root, 'node_modules', 'Claude-Hidden'))
    claudeProfile(path.join(root, 'a', 'b', 'c', 'd', 'Claude-Deep'))
    const found = (await scanTree(root, 3)).map(f => path.relative(root, f.dir))
    assert.deepEqual(found, [path.join('.launcher', 'profiles', 'Claude-Work')])
    const parent = await inspectProfileFolder(path.join(root, '.launcher'))
    assert.deepEqual(parent, { kind: 'parent', apps: { claude: 1 } })
    assert.deepEqual(await inspectProfileFolder(path.join(root, '.launcher', 'profiles', 'Claude-Work')), { kind: 'profile', app: 'claude' })
    assert.deepEqual(await inspectProfileFolder(path.join(root, 'a')), { kind: 'none' }, '두 단계보다 깊으면 상위 폴더로 보지 않는다')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('목록: 기본·같은 이름·실행 중에 본 폴더·직접 추가한 상위 폴더, 제외, 중복 없음', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-prof-'))
  const roaming = path.join(root, 'Roaming')
  try {
    claudeProfile(path.join(roaming, 'Claude'))
    claudeProfile(path.join(roaming, 'Claude-Account2'))
    claudeProfile(path.join(root, 'launcher', 'profiles', 'Claude-Work'))
    claudeProfile(path.join(root, 'tool', 'p1'))
    cursorProfile(path.join(root, 'tool', 'cur2'), 'user_B', 'b@x.io')
    await withEnv({ APPDATA: roaming, LOCALAPPDATA: path.join(root, 'Local'), XDG_CONFIG_HOME: roaming }, async () => {
      AppProfiles.reset()
      AppProfiles.configure({
        added: [path.join(root, 'tool')],
        learned: [{ dir: path.join(root, 'launcher', 'profiles', 'Claude-Work'), via: 'running', seenAt: '' }, { dir: path.join(roaming, 'Claude'), via: 'running', seenAt: '' }],
        excluded: [path.join(roaming, 'Claude-Account2')],
        scanProcesses: false,
      })
      assert.equal(await AppProfiles.refresh(true), null, '사라진 폴더가 없으면 기억 목록은 그대로')
      const all = AppProfiles.list(undefined, true).map(p => [path.relative(root, p.dir), p.app, p.source, p.excluded])
      assert.deepEqual(all.sort(), [
        [path.join('Roaming', 'Claude'), 'claude', 'default', false],
        [path.join('Roaming', 'Claude-Account2'), 'claude', 'sibling', true],
        [path.join('launcher', 'profiles', 'Claude-Work'), 'claude', 'running', false],
        [path.join('tool', 'cur2'), 'cursor', 'added', false],
        [path.join('tool', 'p1'), 'claude', 'added', false],
      ].sort())
      assert.equal(AppProfiles.dirs('claude').length, 3, '제외한 폴더는 조회 목록에서 빠진다')
      assert.equal(AppProfiles.under(path.join(root, 'tool')).length, 2)
      // 같은 Cursor 사용자는 하나로 묶고 이메일을 읽는다.
      const users = cursorUsers()
      assert.equal(users.length, 1)
      assert.equal(users[0].userId, 'user_B')
      assert.equal(users[0].email, 'b@x.io')
      // 기억한 폴더가 지워지면 잊는다.
      fs.rmSync(path.join(root, 'launcher'), { recursive: true, force: true })
      const learned = await AppProfiles.refresh(true)
      assert.deepEqual(learned?.map(l => pathKey(l.dir)), [pathKey(path.join(roaming, 'Claude'))])
    })
  } finally { AppProfiles.reset(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('Cursor 상태 DB는 바뀌지 않았으면 다시 읽지 않고, 바뀌면 새로 읽는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-cur-'))
  try {
    cursorProfile(dir, 'user_1', 'one@x.io')
    const gs = path.join(dir, 'User', 'globalStorage')
    assert.equal(readCursorToken(gs)?.email, 'one@x.io')
    assert.equal(readCursorToken(gs), readCursorToken(gs), '같은 결과 객체(다시 읽지 않음)')
    fs.writeFileSync(path.join(gs, 'state.vscdb'), Buffer.from(`cursorAuth/accessToken${jwt('auth0|user_2', 4e9)} cursorAuth/cachedEmailtwo@x.io\x00index "cursorAuth/cachedEmail":1`, 'latin1'))
    assert.equal(readCursorToken(gs)?.userId, 'user_2')
    assert.equal(readCursorToken(gs)?.email, 'two@x.io')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('찾은 사용자를 카드로: 예전 카드 이어 쓰기, 새 사용자 추가, 지운 사용자 다시 넣지 않기', () => {
  const o = { provider: 'cursor' as const, field: 'cursorUser' as const, idPrefix: 'cursor' }
  const legacy: AccountConfig = { id: 'local-cursor', name: 'Cursor', provider: 'cursor', enabled: true }
  const found = [{ key: 'user_B', label: 'Cursor · b', primary: false }, { key: 'user_A', label: 'Cursor · a', primary: true }]
  // 이 서비스 카드가 없으면 늘리지 않는다.
  assert.equal(syncIdentityAccounts([], [], found, o).changed, false)
  const r = syncIdentityAccounts([legacy], [], found, o)
  assert.equal(r.accounts[0].cursorUser, 'user_A', '예전 카드는 기본 폴더 사용자에')
  assert.equal(r.accounts[0].name, 'Cursor', '이름은 그대로')
  assert.equal(r.accounts.length, 2)
  assert.equal(r.accounts[1].cursorUser, 'user_B')
  assert.deepEqual(r.seen.sort(), ['user_A', 'user_B'])
  // user_B 카드를 지우면 다시 생기지 않는다.
  const again = syncIdentityAccounts([r.accounts[0]], r.seen, found, o)
  assert.equal(again.changed, false)
  assert.equal(again.accounts.length, 1)
  // 처음 보는 사용자는 추가된다.
  const more = syncIdentityAccounts(again.accounts, again.seen, [...found, { key: 'user_C', label: 'Cursor · c', primary: false }], o)
  assert.deepEqual(more.accounts.map(a => a.cursorUser), ['user_A', 'user_C'])
})
