import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AppState, WebStatus } from '../common/types.js'

/**
 * 사용량을 브라우저로 보여 주는 작은 웹 서버. 페이지는 창과 같은 화면(view=web)이고 보기만 한다:
 * 받는 요청은 화면 파일·상태 읽기·상태 변경 알림(SSE)·암호 입력뿐이고, 앱 설정이나 조회를 바꾸는 길은 없다.
 * - 다른 기기 접속을 끄면 127.0.0.1에만 열고, Host 머리글도 이 PC 주소만 받는다(DNS 리바인딩 방지).
 * - 암호를 정하면 먼저 암호를 묻고, 맞으면 세션 쿠키를 준다. 암호는 scrypt 해시로만 저장한다.
 */
export interface WebOptions { enabled: boolean; remote: boolean; port: number; passwordHash?: string }

export const DEFAULT_WEB_PORT = 47100
const COOKIE = 'aiu_session'

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 32).toString('hex')}`
}

function passwordMatches(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const got = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32), want = Buffer.from(hash, 'hex')
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }

/** 브라우저로 보낼 상태: 화면에 필요한 값만 남기고, 이 PC의 경로·창 위치·암호 해시 같은 값은 뺀다. */
export function publicState(s: AppState): AppState {
  const { windowBounds: _w, popupBounds: _p, layoutsByMonitor: _l, webPasswordHash: _h, shortcuts: _s, ...config } = s.config
  return {
    preview: s.preview,
    version: s.version,
    config,
    accounts: s.accounts.map(({ launchCli: _c, launchApp: _a, launchCwd: _d, homeDir: _hd, ...a }) => a),
    usages: s.usages,
    isRefreshing: s.isRefreshing,
    lastRefreshedAt: s.lastRefreshedAt,
    history: s.history,
  }
}

export class WebServer {
  private server: http.Server | null = null
  private opts: WebOptions | null = null
  private readonly clients = new Set<http.ServerResponse>()
  private readonly sessions = new Set<string>()
  private keepAlive: ReturnType<typeof setInterval> | undefined
  status: WebStatus = { running: false, urls: [] }

  constructor(private readonly distDir: string, private readonly getState: () => AppState, private readonly onStatus: () => void) {}

  /** 설정이 바뀌면 부른다. 켜기·다른 기기 접속·포트가 바뀌면 다시 열고, 암호가 바뀌면 열려 있던 세션을 끊는다. */
  apply(next: WebOptions) {
    const prev = this.opts
    this.opts = next
    if (prev && prev.passwordHash !== next.passwordHash) { this.sessions.clear(); this.dropClients() }
    if (prev && prev.enabled === next.enabled && prev.remote === next.remote && prev.port === next.port) return
    this.stop()
    if (next.enabled) this.start(next)
  }

  /** 상태가 바뀔 때마다 열려 있는 페이지에 새 상태를 보낸다. */
  push() {
    if (!this.clients.size) return
    const data = `data: ${JSON.stringify(publicState(this.getState()))}\n\n`
    for (const res of this.clients) res.write(data)
  }

  stop() {
    this.dropClients()
    clearInterval(this.keepAlive)
    this.server?.close()
    this.server = null
    if (this.status.running || this.status.error) { this.status = { running: false, urls: [] }; this.onStatus() }
  }

  private start(o: WebOptions) {
    const server = this.server = http.createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }) })
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (this.server !== server) return
      this.server = null
      this.status = { running: false, urls: [], error: err.code === 'EADDRINUSE' ? `포트 ${o.port}번을 다른 프로그램이 쓰고 있어요. 다른 포트로 바꿔 주세요.` : `웹 페이지를 열지 못했어요(${err.code || err.message}).` }
      this.onStatus()
    })
    server.listen(o.port, o.remote ? '0.0.0.0' : '127.0.0.1', () => {
      if (this.server !== server) return
      this.status = { running: true, urls: this.urls(o) }
      this.onStatus()
    })
    // 프록시·절전이 조용한 연결을 끊지 않게 가끔 빈 줄을 보낸다.
    this.keepAlive = setInterval(() => { for (const res of this.clients) res.write(': keep-alive\n\n') }, 25_000)
  }

  private urls(o: WebOptions): string[] {
    const out = [`http://localhost:${o.port}/`]
    if (o.remote) for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${o.port}/`)
    return out
  }

  private dropClients() {
    for (const res of this.clients) res.end()
    this.clients.clear()
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const o = this.opts
    if (!o) { res.writeHead(503); res.end(); return }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    // 이 PC에서만 볼 때는 이 PC 주소로 들어온 요청만 받는다.
    const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
    if (!o.remote && !['localhost', '127.0.0.1', '::1'].includes(host)) { res.writeHead(403); res.end(); return }
    const url = new URL(req.url || '/', 'http://localhost')

    if (o.passwordHash && !this.signedIn(req)) {
      if (req.method === 'POST' && url.pathname === '/login') return this.login(req, res, o.passwordHash)
      if (url.pathname.startsWith('/api/')) { res.writeHead(401); res.end(); return }
      return this.loginPage(res, false)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }

    if (url.pathname === '/' || url.pathname === '/login') { res.writeHead(302, { Location: '/index.html?view=web' }); res.end(); return }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(publicState(this.getState())))
      return
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      res.write('\n')
      this.clients.add(res)
      req.on('close', () => this.clients.delete(res))
      return
    }
    // 화면 파일: 빌드한 dist 폴더 안의 index.html과 assets만 보낸다.
    const rel = url.pathname === '/index.html' ? 'index.html' : url.pathname.startsWith('/assets/') ? url.pathname.slice(1) : ''
    const file = rel && path.resolve(this.distDir, decodeURIComponent(rel))
    if (!file || !file.startsWith(path.resolve(this.distDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': rel === 'index.html' ? 'no-store' : 'max-age=3600' })
    if (req.method === 'HEAD') { res.end(); return }
    fs.createReadStream(file).pipe(res)
  }

  private signedIn(req: http.IncomingMessage): boolean {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || '')
    return !!m && this.sessions.has(m[1])
  }

  private async login(req: http.IncomingMessage, res: http.ServerResponse, hash: string) {
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 2048) { res.writeHead(413); res.end(); return } }
    const password = new URLSearchParams(body).get('password') || ''
    if (!passwordMatches(password, hash)) {
      // 틀리면 잠깐 기다려 마구 대입하기 어렵게 한다.
      await new Promise(r => setTimeout(r, 600))
      return this.loginPage(res, true)
    }
    const id = crypto.randomBytes(32).toString('hex')
    this.sessions.add(id)
    res.writeHead(303, { Location: '/index.html?view=web', 'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` })
    res.end()
  }

  private loginPage(res: http.ServerResponse, wrong: boolean) {
    res.writeHead(wrong ? 401 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 사용량</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.5 "Segoe UI","Malgun Gothic",system-ui,sans-serif;background:#111217;color:#eeeef3}
@media (prefers-color-scheme:light){body{background:#f6f6f9;color:#23232f}form{background:#fff!important;border-color:#0001!important}input{background:#f6f6f9!important;color:#23232f!important}}
form{width:min(320px,calc(100vw - 32px));padding:24px;border:1px solid #fff2;border-radius:12px;background:#1c1d24;display:grid;gap:12px}
h1{margin:0;font-size:17px}p{margin:0;font-size:12px;opacity:.7}.bad{color:#ff6b73;opacity:1}
input{font:inherit;padding:9px 11px;border:1px solid #8cbbff66;border-radius:8px;background:#111217;color:#eeeef3}
button{font:inherit;padding:9px;border:0;border-radius:8px;background:#8cbbff;color:#111217;font-weight:600;cursor:pointer}</style></head>
<body><form method="post" action="/login"><h1>AI 사용량</h1><p>앱 설정에서 정한 접속 암호를 넣어 주세요.</p>${wrong ? '<p class="bad">암호가 맞지 않아요.</p>' : ''}
<input type="password" name="password" autocomplete="current-password" aria-label="접속 암호" required autofocus><button>보기</button></form></body></html>`)
  }
}
