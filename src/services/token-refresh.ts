import fs from 'node:fs'

/**
 * 다른 CLI의 로그인 토큰을 '만료된 뒤에만' 대신 갱신하는 공통 규칙(Claude Code·Grok).
 * CLI는 쓰는 동안 만료 직전에 스스로 새로 받는다. 위젯은 만료되고 REFRESH_GRACE_MS가 지나도록 아무도 갱신하지 않았을 때만
 * CLI와 같은 주소·형식으로 갱신해 그 CLI의 로그인 파일에 다시 쓴다. 그 시점엔 쓰는 중인 유효한 토큰이 없어 CLI와 부딪히지 않는다.
 * 실패하면 RETRY_AFTER_FAIL_MS 동안 다시 시도하지 않고, 갱신 토큰이 무효면 '다시 로그인'으로 표시한다. 토큰 값은 남기지 않는다.
 */
export const REFRESH_GRACE_MS = 10 * 60e3
export const RETRY_AFTER_FAIL_MS = 60 * 60e3

export interface RefreshableToken { refreshToken?: string; expiresAt?: number; refreshTokenExpiresAt?: number }
export type RefreshDecision = 'refresh' | 'fresh' | 'wait' | 'relogin' | 'none'
export type RefreshResult = RefreshDecision | 'refreshed' | 'failed'

/** 지금 대신 갱신할지(순수 판단). lastFailAt은 마지막 실패 시각. */
export function refreshDecision(o: RefreshableToken | undefined, now: number, lastFailAt = 0): RefreshDecision {
  if (!o || typeof o.refreshToken !== 'string' || !o.refreshToken || typeof o.expiresAt !== 'number' || o.expiresAt <= 0) return 'none'
  if (typeof o.refreshTokenExpiresAt === 'number' && o.refreshTokenExpiresAt <= now) return 'relogin'
  if (now < o.expiresAt + REFRESH_GRACE_MS) return o.expiresAt > now ? 'fresh' : 'wait'
  if (lastFailAt && now - lastFailAt < RETRY_AFTER_FAIL_MS) return 'wait'
  return 'refresh'
}

let enabled = false
/** 실제 사용자 데이터로 도는 앱에서만 켠다(미리보기는 다른 앱의 로그인 파일을 건드리지 않는다). */
export function setRefreshEnabled(on: boolean) { enabled = on }

/** 로그인 파일(키)마다 마지막 실패·'다시 로그인 필요'를 따로 세고, 같은 키의 갱신은 한 번만 돌린다. */
export class RefreshTracker {
  private lastFailAt = new Map<string, number>()
  private relogin = new Map<string, boolean>()
  private running = new Map<string, Promise<RefreshResult>>()

  failedAt(key: string) { return this.lastFailAt.get(key) || 0 }
  needsRelogin(key: string) { return this.relogin.get(key) === true }
  /** 판단 결과를 기록한다('relogin'이면 다시 로그인 필요로 표시). */
  decided(key: string, d: RefreshDecision) { this.relogin.set(key, d === 'relogin'); return d }
  /** 실패. relogin을 주면 '다시 로그인 필요' 여부도 바꾼다. */
  fail(key: string, relogin?: boolean): 'failed' { this.lastFailAt.set(key, Date.now()); if (relogin !== undefined) this.relogin.set(key, relogin); return 'failed' }
  ok(key: string): 'refreshed' { this.lastFailAt.delete(key); this.relogin.set(key, false); return 'refreshed' }

  /** 꺼져 있으면 아무것도 하지 않는다. 같은 키로 여러 곳에서 불러도 한 번만 돈다. */
  once(key: string, job: () => Promise<RefreshResult>): Promise<RefreshResult> {
    if (!enabled) return Promise.resolve('none')
    let p = this.running.get(key)
    if (!p) { p = job().catch(() => this.fail(key)).finally(() => this.running.delete(key)); this.running.set(key, p) }
    return p
  }
}

/** 다른 항목은 그대로 두고 같은 형식으로 원자적으로 쓴다(임시 파일에 쓴 뒤 바꿔치기). */
export function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** 갱신 토큰이 무효(만료·다른 곳에서 이미 사용)라는 응답인지. */
export const isInvalidGrant = (status: number, body: string) => (status === 400 || status === 401) && body.includes('invalid_grant')
