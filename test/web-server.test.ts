import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebServer, hashPassword, publicState } from '../src/main/web-server.js'
import type { AppState } from '../src/common/types.js'

const state = (): AppState => ({
  config: { theme: '1a', webPasswordHash: hashPassword('secret1'), windowBounds: { x: 1, y: 2, width: 3, height: 4 }, shortcuts: { toggle: 'Ctrl+Alt+U' } } as any,
  accounts: [{ id: 'a', name: 'Claude', provider: 'claude', enabled: true, launchCli: 'C:\\x\\claude.exe', homeDir: 'C:\\h' }],
  usages: [],
  isRefreshing: false,
  lastRefreshedAt: '',
})

test('웹으로 보내는 상태에는 암호 해시·이 PC 경로·창 위치·단축키가 없다', () => {
  const s = publicState(state())
  assert.equal((s.config as any).webPasswordHash, undefined)
  assert.equal((s.config as any).windowBounds, undefined)
  assert.equal((s.config as any).shortcuts, undefined)
  assert.equal((s.accounts[0] as any).launchCli, undefined)
  assert.equal((s.accounts[0] as any).homeDir, undefined)
  assert.equal(s.accounts[0].name, 'Claude')
})

test('암호 해시는 매번 다른 소금을 쓴다', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'))
})

async function withServer(opts: { remote: boolean; password?: string }, fn: (base: string) => Promise<void>) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-web-'))
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>t</title>')
  const port = 47200 + Math.floor(Math.random() * 500)
  let ready!: () => void
  const started = new Promise<void>(r => { ready = r })
  const srv: WebServer = new WebServer(dist, state, () => { if (srv.status.running || srv.status.error) ready() })
  srv.apply({ enabled: true, remote: opts.remote, port, passwordHash: opts.password ? hashPassword(opts.password) : undefined })
  await started
  try { await fn(`http://127.0.0.1:${port}`) } finally { srv.stop(); fs.rmSync(dist, { recursive: true, force: true }) }
}

test('암호가 없으면 상태를 읽을 수 있고, 바꾸는 요청은 받지 않는다', async () => {
  await withServer({ remote: false }, async base => {
    const r = await fetch(`${base}/api/state`)
    assert.equal(r.status, 200)
    assert.equal(((await r.json()) as AppState).accounts[0].name, 'Claude')
    assert.equal((await fetch(`${base}/api/state`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}/index.html`)).status, 200)
    assert.equal((await fetch(`${base}/assets/../../etc`)).status, 404)
  })
})

test('이 PC에서만 볼 때는 다른 주소 이름(Host)으로 온 요청을 거절한다', async () => {
  await withServer({ remote: false }, async base => {
    // fetch는 Host 머리글을 바꾸지 못하므로 http.request로 보낸다.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/state`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode || 0) })
      req.on('error', reject); req.end()
    })
    assert.equal(status, 403)
  })
})

test('암호를 정하면 맞는 암호로 들어온 뒤에만 상태를 읽는다', async () => {
  await withServer({ remote: false, password: 'secret1' }, async base => {
    assert.equal((await fetch(`${base}/api/state`)).status, 401)
    const page = await fetch(`${base}/`)
    assert.match(await page.text(), /접속 암호/)
    const wrong = await fetch(`${base}/login`, { method: 'POST', body: 'password=nope', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' })
    assert.equal(wrong.status, 401)
    const ok = await fetch(`${base}/login`, { method: 'POST', body: 'password=secret1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' })
    assert.equal(ok.status, 303)
    const cookie = (ok.headers.get('set-cookie') || '').split(';')[0]
    assert.match(cookie, /^aiu_session=[a-f0-9]{64}$/)
    assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status, 200)
  })
})
