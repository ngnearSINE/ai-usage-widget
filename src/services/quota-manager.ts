import fs from 'node:fs'
import path from 'node:path'
import { AntigravityCliClient } from './antigravity-cli-client.js'
import { fetchClaudeUsage } from './claude-usage-client.js'
import { CodexLocalClient } from './codex-local-client.js'
import { GrokCliClient } from './grok-cli-client.js'
import { ClaudeOrgs, cliTokenExpired } from './claude-orgs.js'
import { AccountStore } from './account-store.js'
import type { AccountConfig, AccountUsage } from '../common/types.js'
import { retainedUsage } from '../common/widget-layout.js'

export class QuotaManager {
  private usages: Map<string, AccountUsage> = new Map()
  // 마지막 실측값. 파일에도 남겨 재시작 직후 조회가 실패해도(로그인 만료 등) 마지막 값을 '갱신 지연'으로 보여 준다.
  private lastGood: Map<string, AccountUsage> = new Map()
  private lastGoodSaveTimer: NodeJS.Timeout | undefined
  private timer: NodeJS.Timeout | null = null
  private isRefreshing: boolean = false
  private onStateChangeListeners: Array<(usages: AccountUsage[]) => void> = []

  constructor(private accountStore: AccountStore, private readonly lastGoodFile?: string) {
    if (!lastGoodFile) return
    try {
      const saved = JSON.parse(fs.readFileSync(lastGoodFile, 'utf-8')) as Record<string, AccountUsage>
      for (const [id, u] of Object.entries(saved)) if (u && typeof u === 'object' && u.primaryQuota) this.lastGood.set(id, { ...u, status: 'stale' })
    } catch { /* 처음 실행이거나 파일이 없음 */ }
  }

  private saveLastGood() {
    if (!this.lastGoodFile) return
    clearTimeout(this.lastGoodSaveTimer)
    this.lastGoodSaveTimer = setTimeout(() => {
      try {
        const ids = new Set(this.accountStore.getAccounts().map(a => a.id))
        const out: Record<string, AccountUsage> = {}
        for (const [id, u] of this.lastGood) if (ids.has(id) && !u.isEstimated) out[id] = u
        fs.mkdirSync(path.dirname(this.lastGoodFile!), { recursive: true })
        fs.writeFileSync(`${this.lastGoodFile}.tmp`, JSON.stringify(out), 'utf-8')
        fs.renameSync(`${this.lastGoodFile}.tmp`, this.lastGoodFile!)
      } catch (err) { console.warn('[QuotaManager] 마지막 사용량을 저장하지 못했습니다:', err) }
    }, 1000)
  }

  public addListener(listener: (usages: AccountUsage[]) => void) {
    this.onStateChangeListeners.push(listener)
  }

  private notify() {
    const list = this.getUsages()
    for (const listener of this.onStateChangeListeners) {
      try {
        listener(list)
      } catch (err) {
        console.error('[QuotaManager] Listener error', err)
      }
    }
  }

  public getUsages(): AccountUsage[] {
    const accounts = this.accountStore.getAccounts().filter(a => a.enabled)
    const result: AccountUsage[] = []

    for (const acc of accounts) {
      const existing = this.usages.get(acc.id)
      if (existing) {
        result.push(existing)
      } else {
        result.push(this.createInitialUsage(acc))
      }
    }
    return result
  }

  public get refreshing(): boolean { return this.isRefreshing }

  /**
   * customMock 이 정직한 데이터 소스인 계정인지.
   * 사용자가 직접 수치를 입력해 만든 custom 계정에서만 참이고,
   * 실계정(claude/codex/antigravity/google)의 프리셋 숫자는 실측을 대신할 수 없다.
   */
  private static isManualAccount(
    acc: AccountConfig
  ): acc is AccountConfig & { customMock: NonNullable<AccountConfig['customMock']> } {
    return acc.provider === 'custom' && !!acc.customMock
  }

  private createInitialUsage(acc: AccountConfig): AccountUsage {
    if (QuotaManager.isManualAccount(acc)) {
      const isWeeklyOnly = !!acc.customMock.isWeeklyOnly
      const primaryPct = isWeeklyOnly ? acc.customMock.weeklyPercent : acc.customMock.primaryPercent
      const primaryReset = isWeeklyOnly ? acc.customMock.weeklyReset : acc.customMock.primaryReset

      return {
        id: acc.id,
        name: acc.name,
        provider: acc.provider,
        iconLetter: acc.customMock.iconLetter || acc.name.charAt(0).toUpperCase(),
        brandColor: acc.customMock.brandColor || '#3B82F6',
        status: 'ready',
        isEstimated: true, // 사용자가 손으로 넣은 값이지 실측이 아니다
        isWeeklyOnly,
        primaryQuota: {
          remainingFraction: (100 - primaryPct) / 100,
          percentLeft: 100 - primaryPct,
          percentUsed: primaryPct,
          resetCountdown: primaryReset,
          isExhausted: primaryPct >= 100
        },
        weeklyQuota: {
          remainingFraction: (100 - acc.customMock.weeklyPercent) / 100,
          percentLeft: 100 - acc.customMock.weeklyPercent,
          percentUsed: acc.customMock.weeklyPercent,
          resetCountdown: acc.customMock.weeklyReset,
          isExhausted: acc.customMock.weeklyPercent >= 100
        },
        updatedAt: new Date().toISOString()
      }
    }

    return {
      id: acc.id,
      name: acc.name,
      provider: acc.provider,
      iconLetter: acc.name.charAt(0).toUpperCase(),
      brandColor: '#4285F4',
      status: 'loading',
      primaryQuota: {
        remainingFraction: 1.0,
        percentLeft: 100,
        percentUsed: 0,
        resetCountdown: '--',
        isExhausted: false
      },
      updatedAt: new Date().toISOString()
    }
  }

  public async refreshAll(): Promise<AccountUsage[]> {
    if (this.isRefreshing) return this.getUsages()
    this.isRefreshing = true

    try {
      // Claude 조직(팀/개인)을 찾아 계정 목록에 맞춘다. 실패해도 나머지 조회는 계속한다.
      try {
        const orgs = await ClaudeOrgs.discover()
        this.accountStore.syncClaudeOrgs(orgs.map(o => ({ orgUuid: o.orgUuid, label: o.label, fromCli: o.tokens.some(t => t.source === 'cli') })), cliTokenExpired())
      } catch (err) {
        console.warn('[QuotaManager] Claude 조직 확인 실패', err)
      }
      const accounts = this.accountStore.getAccounts().filter(a => a.enabled)
      const activeIds = new Set(accounts.map(a => a.id))

      // 비활성화되거나 제거된 계정 캐시 정리 (메모리 누수 방지)
      for (const id of this.usages.keys()) {
        if (!activeIds.has(id)) {
          this.usages.delete(id)
        }
      }

      await Promise.allSettled(
        accounts.map(async (acc) => {
          try {
            let usage: AccountUsage | null = null

            // 실시간 로컬/API 세션 우선 조회
            if (acc.provider === 'antigravity' || acc.isLocalIde) {
              // agy CLI가 기존 로그인 세션으로 조회 (RPC 포트/CSRF/토큰을 다루지 않음)
              usage = await AntigravityCliClient.fetchUsage(acc)
              // 다른 공급자와 같은 stale 보존 규칙을 아래에서 적용한다.
            } else if (acc.provider === 'claude' && acc.orgUuid) {
              usage = await ClaudeOrgs.fetchUsage(acc)
            } else if (acc.provider === 'claude') {
              usage = await fetchClaudeUsage(acc)
            } else if (acc.provider === 'codex') {
              usage = await CodexLocalClient.fetchUsage(acc)
            } else if (acc.provider === 'xai') {
              usage = await GrokCliClient.fetchUsage(acc)
            } else if (QuotaManager.isManualAccount(acc)) {
              // 실시간 조회 대상이 아닌 수동 입력 계정: 입력값이 곧 데이터
              usage = this.createInitialUsage(acc)
            } else {
              // 실시간 조회 클라이언트가 없는 provider (예: google). 프리셋 숫자로 채우지 않는다
              usage = {
                ...this.createInitialUsage(acc),
                status: 'error',
                errorMessage: `${acc.provider} 실시간 쿼터 조회를 지원하지 않습니다`
              }
            }

            usage = retainedUsage(usage, this.lastGood.get(acc.id))
            if (usage.status === 'ready' || usage.status === 'stale') this.lastGood.set(acc.id, usage)
            this.usages.set(acc.id, usage)
          } catch (err) {
            console.error(`[QuotaManager] Error fetching usage for ${acc.name}:`, err)
            const fallback = retainedUsage({ ...(this.usages.get(acc.id) || this.createInitialUsage(acc)),
              status: 'error', errorMessage: err instanceof Error ? err.message : String(err) }, this.lastGood.get(acc.id))
            this.usages.set(acc.id, fallback)
          }
        })
      )
    } finally {
      this.isRefreshing = false
      this.saveLastGood()
      this.notify()
    }

    return this.getUsages()
  }

  public startPolling(intervalSec: number, immediate = true) {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const safeInterval = Math.max(10, intervalSec) * 1000
    this.timer = setInterval(() => {
      this.refreshAll().catch(e => console.warn('[QuotaManager] Polling error', e))
    }, safeInterval)

    if (immediate) {
      this.refreshAll().catch(e => console.warn('[QuotaManager] Initial refresh error', e))
    }
  }

  public stopPolling() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
