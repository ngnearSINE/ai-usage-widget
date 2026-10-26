import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AccountConfig, AccountUsage } from '../common/types.js'
import { parseClaudeDesktopLiveUsage, parseRetryAfterMs, readClaudeDesktopTokens } from './claude-desktop-oauth.js'

/**
 * Claude 조직(팀/개인)별 사용량. 한 계정(이메일)이 여러 조직에 속할 수 있고 한도와 로그인 토큰은 조직마다 따로다.
 * CLI(~/.claude/.credentials.json)와 데스크톱 앱 캐시에 있는 토큰을 모두 모아 /api/oauth/profile로 조직을 확인하고,
 * 조직마다 카드 하나로 보여 준다. 토큰은 읽기만 하고 갱신하지 않는다(각 앱이 갱신한다).
 */
const API = 'https://api.anthropic.com/api/oauth'
const DISCOVER_TTL_MS = 60e3
const USAGE_MIN_INTERVAL_MS = 30e3

export interface ClaudeToken { token: string; expiresAt: number | null; source: 'cli' | 'desktop'; scopes: string[] }
export interface ClaudeProfile { orgUuid: string; orgName: string; orgType: string; rateTier?: string; email: string }
export interface ClaudeOrg extends ClaudeProfile { label: string; kind: string; tokens: ClaudeToken[] }

const KIND: Record<string, string> = { claude_team: '팀', claude_enterprise: '엔터프라이즈' }

/** 카드 기본 이름: 팀은 조직 이름, 개인은 이메일 앞부분. */
export function claudeOrgLabel(p: Pick<ClaudeProfile, 'orgType' | 'orgName' | 'email'>) {
  const kind = KIND[p.orgType] || '개인'
  const who = kind === '개인' ? (p.email.split('@')[0] || p.orgName) : p.orgName
  return { kind, label: `Claude ${kind} · ${who}` }
}

/** 토큰을 조직별로 묶는다. 조직 안에서는 Claude Code 범위가 있는 것, CLI, 만료가 늦은 순으로 먼저 쓴다. */
export function groupClaudeOrgs(found: Array<{ token: ClaudeToken; profile: ClaudeProfile }>): ClaudeOrg[] {
  const byOrg = new Map<string, ClaudeOrg>()
  for (const { token, profile } of found) {
    const org = byOrg.get(profile.orgUuid) || { ...profile, ...claudeOrgLabel(profile), tokens: [] }
    if (!org.tokens.some(t => t.token === token.token)) org.tokens.push(token)
    byOrg.set(profile.orgUuid, org)
  }
  const score = (t: ClaudeToken) => (t.scopes.includes('user:sessions:claude_code') ? 2 : 0) + (t.source === 'cli' ? 1 : 0)
  for (const org of byOrg.values()) org.tokens.sort((a, b) => score(b) - score(a) || (b.expiresAt ?? Infinity) - (a.expiresAt ?? Infinity))
  // 팀·엔터프라이즈를 앞에, 그다음 이름 순.
  return [...byOrg.values()].sort((a, b) => Number(b.kind !== '개인') - Number(a.kind !== '개인') || a.label.localeCompare(b.label))
}

/** CLI 로그인 파일은 있는데 토큰이 만료된 상태(어느 조직인지 아직 모름). */
export function cliTokenExpired(): boolean {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  try {
    const oauth = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf-8')).claudeAiOauth
    return typeof oauth?.accessToken === 'string' && typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()
  } catch { return false }
}

function readCliToken(): ClaudeToken | null {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  try {
    const oauth = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf-8')).claudeAiOauth
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null
    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null
    if (expiresAt !== null && expiresAt <= Date.now()) return null
    return { token: oauth.accessToken, expiresAt, source: 'cli', scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [] }
  } catch { return null }
}

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' })
const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 16)

export class ClaudeOrgs {
  private static orgs: ClaudeOrg[] = []
  private static discoveredAt = 0
  private static pending: Promise<ClaudeOrg[]> | null = null
  // 토큰마다 조직은 바뀌지 않으므로 지문으로 기억해 profile 호출을 아낀다.
  private static profiles = new Map<string, ClaudeProfile>()
  private static lastUsage = new Map<string, { at: number; usage: AccountUsage }>()
  private static backoffUntil = new Map<string, number>()

  static discover(force = false): Promise<ClaudeOrg[]> {
    if (!force && Date.now() - this.discoveredAt < DISCOVER_TTL_MS) return Promise.resolve(this.orgs)
    this.pending ||= this.scan().finally(() => { this.pending = null })
    return this.pending
  }

  private static async scan(): Promise<ClaudeOrg[]> {
    const tokens: ClaudeToken[] = []
    const cli = readCliToken()
    if (cli) tokens.push(cli)
    for (const t of await readClaudeDesktopTokens()) tokens.push({ token: t.token, expiresAt: t.expiresAt, source: 'desktop', scopes: t.scopes })
    const found: Array<{ token: ClaudeToken; profile: ClaudeProfile }> = []
    await Promise.all(tokens.map(async token => {
      const profile = await this.profileOf(token.token)
      if (profile) found.push({ token, profile })
    }))
    // 한 번도 조직을 확인하지 못했으면(네트워크 오류 등) 지난 결과를 유지한다.
    if (found.length || !tokens.length) this.orgs = groupClaudeOrgs(found)
    this.discoveredAt = Date.now()
    return this.orgs
  }

  private static async profileOf(token: string): Promise<ClaudeProfile | null> {
    const key = fingerprint(token), known = this.profiles.get(key)
    if (known) return known
    try {
      const res = await fetch(`${API}/profile`, { headers: headers(token), signal: AbortSignal.timeout(5000), redirect: 'error' })
      if (!res.ok) { await res.body?.cancel().catch(() => {}); return null }
      const j = await res.json() as { account?: { email?: string }; organization?: { uuid?: string; name?: string; organization_type?: string; rate_limit_tier?: string } }
      if (!j.organization?.uuid) return null
      const profile = { orgUuid: j.organization.uuid, orgName: j.organization.name || '', orgType: j.organization.organization_type || '', rateTier: j.organization.rate_limit_tier, email: j.account?.email || '' }
      this.profiles.set(key, profile)
      return profile
    } catch { return null }
  }

  static async fetchUsage(account: AccountConfig): Promise<AccountUsage> {
    const orgUuid = account.orgUuid!
    const cached = this.lastUsage.get(orgUuid)
    if (cached && Date.now() - cached.at < USAGE_MIN_INTERVAL_MS) return { ...cached.usage, id: account.id, name: account.name }
    if ((this.backoffUntil.get(orgUuid) || 0) > Date.now()) throw new Error('Claude 사용량 API 요청 제한으로 잠시 쉬는 중')
    const org = (await this.discover()).find(o => o.orgUuid === orgUuid)
    if (!org) throw new Error('이 조직의 로그인 토큰이 없거나 만료됐어요. Claude 앱에서 이 조직으로 한 번 전환하거나 claude를 실행하세요')
    let lastStatus = 0
    for (const t of org.tokens) {
      // 한 토큰의 네트워크 오류(시간 초과 등)로 나머지 토큰을 건너뛰지 않는다.
      let res: Response
      try { res = await fetch(`${API}/usage`, { headers: headers(t.token), signal: AbortSignal.timeout(5000), redirect: 'error' }) }
      catch { continue }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => {})
        this.backoffUntil.set(orgUuid, Date.now() + parseRetryAfterMs(res.headers.get('retry-after')))
        throw new Error('Claude 사용량 API 요청 제한(HTTP 429)')
      }
      if (!res.ok) { lastStatus = res.status; await res.body?.cancel().catch(() => {}); continue }
      const usage = parseClaudeDesktopLiveUsage(await res.json(), account)
      const result: AccountUsage = { ...usage, name: account.name || org.label, email: org.email, tier: `${org.kind} · ${org.kind === '개인' ? org.email : org.orgName}`, dataSource: t.source === 'cli' ? 'claude-cli' : 'claude-desktop-live' }
      this.lastUsage.set(orgUuid, { at: Date.now(), usage: result })
      return result
    }
    // 토큰이 모두 거절되면 다음 조회 때 다시 찾는다.
    this.discoveredAt = 0
    throw new Error(`이 조직의 사용량을 받지 못했어요${lastStatus ? ` (HTTP ${lastStatus})` : ''}`)
  }
}
