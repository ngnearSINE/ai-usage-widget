import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AccountConfig, WidgetConfig } from '../common/types.js'
import type { DetectedApp } from './local-app-detector.js'
import { GrokCliClient } from './grok-cli-client.js'
import { mergeClaudeAccounts } from './claude-account-migration.js'
import { DEFAULT_API_ENDPOINT } from './usage-push.js'
import { moveAccountBefore } from '../common/widget-layout.js'
import { syncClaudeOrgAccounts, type ClaudeOrgSeen } from '../common/claude-org-sync.js'

const DEFAULT_CONFIG: WidgetConfig = {
  theme: '1a',
  iconStyle: 'color',
  alignment: 'right',
  offsetPx: 20,
  verticalOffsetPx: 0,
  refreshIntervalSec: 60,
  showWeeklyLimit: true,
  colorByUsage: true,
  showCardBackground: true,
  showUsedPercent: false,
  placementMode: 'floating',
  alwaysOnTop: true,
  openAtLogin: true,
  doubleClickToOpenPopup: false,
  apiPushEnabled: false,
  apiEndpoint: DEFAULT_API_ENDPOINT,
  apiScreen: 1,
  uiVersion: 4,
  appearance: 'dark',
  barStyle: 'silk',
  motion: 'subtle',
  accentColor: '#a99bff',
  fontScale: 100,
  cardGap: 6,
  hideDisconnected: true,
  showResetTime: true,
  showServiceName: true,
  opacity: 70,
  useAcrylic: true,
  design: 'rich',
  valueSource: {},
  warnPercent: 20,
  critPercent: 10,
  showPace: true,
  sortLowFirst: false,
  notifyEnabled: true,
  notifyLow: true,
  notifyPace: true,
  notifyReset: false,
  notifyMuted: [],
  notifyUnused: true,
  trayShowNumber: true,
  clickThrough: false,
  shortcuts: { toggle: 'Ctrl+Alt+U', lock: 'Ctrl+Alt+L', cycle: 'Ctrl+Alt+D' },
  rememberPerMonitor: true,
  layoutsByMonitor: {}
}

// 쿼터 수치는 전부 실시간 조회로 채운다. 프리셋 숫자를 넣어두면 조회 실패 시 그게 정상값처럼 표시된다.
// (실시간 조회 클라이언트가 없는 provider 는 기본 계정에 두지 않는다 — loadAccounts 도 'google' 계정을 정리한다)
export const DEFAULT_ACCOUNTS: AccountConfig[] = [
  {
    id: 'local-antigravity',
    name: 'Antigravity (Local IDE)',
    provider: 'antigravity',
    enabled: true,
    isLocalIde: true
  },
  {
    id: 'local-claude-code',
    name: 'Claude Code',
    provider: 'claude',
    enabled: true
  },
  {
    id: 'local-codex',
    name: 'Codex CLI',
    provider: 'codex',
    enabled: true
  },
  {
    id: 'local-grok',
    name: 'Grok',
    provider: 'xai',
    enabled: true
  }
]

/** DEFAULT_ACCOUNTS 는 상수다. toggleAccount 등이 원본을 바꾸지 않도록 항상 깊은 복사본을 준다 */
function createDefaultAccounts(): AccountConfig[] {
  return structuredClone(DEFAULT_ACCOUNTS)
}

export class AccountStore {
  private configPath: string
  private accountsPath: string
  private config: WidgetConfig
  private accounts: AccountConfig[]

  constructor() {
    let baseDir: string
    try {
      baseDir = app ? app.getPath('userData') : path.join(process.cwd(), '.data')
    } catch {
      baseDir = path.join(process.cwd(), '.data')
    }

    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true })
    }

    this.configPath = path.join(baseDir, 'config.json')
    this.accountsPath = path.join(baseDir, 'accounts.json')
    fs.rmSync(path.join(baseDir, 'oauth-client.json'), { force: true }) // 제거된 키 가져오기 기능의 잔여 파일

    this.config = this.loadConfig()
    this.accounts = this.loadAccounts()
    // Grok 연동 이전에 계정 목록을 저장한 사용자에게 한 번만 Grok을 추가한다(이 PC에 Grok CLI가 있을 때만, 지운 뒤엔 다시 넣지 않는다).
    if (!this.config.grokOffered) {
      if (GrokCliClient.isInstalled() && !this.accounts.some(a => a.provider === 'xai')) {
        this.saveAccounts([...this.accounts, structuredClone(DEFAULT_ACCOUNTS.find(a => a.id === 'local-grok')!)])
      }
      this.saveConfig({ ...this.config, grokOffered: true })
    }
  }

  private loadConfig(): WidgetConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8')
        const saved = JSON.parse(raw)
        // 자유 창 도입 시 한 번만 새 기본 배치를 적용하고 기존 외형·계정 설정은 보존한다.
        const config = { ...DEFAULT_CONFIG, ...saved }
        if (!saved.uiVersion || saved.uiVersion < 2) {
          config.placementMode = 'floating'
        }
        // 카드형 대시보드(uiVersion 3)에서 카드 간격 기본값이 12 → 6으로 바뀌었다. 직접 바꾼 값은 보존한다.
        if (!saved.uiVersion || saved.uiVersion < 3) {
          if (saved.cardGap === undefined || saved.cardGap === 12) config.cardGap = DEFAULT_CONFIG.cardGap
        }
        // 배경 소재(아크릴/투명/단색) + 불투명도 두 설정을 Windows Terminal식 '불투명도 + 아크릴' 하나로 합쳤다(uiVersion 4).
        if (!saved.uiVersion || saved.uiVersion < 4) {
          const effect = saved.backgroundEffect || 'acrylic', alpha = Math.max(0, Math.min(100, Number(saved.alphaPercent ?? 85)))
          config.useAcrylic = effect === 'acrylic'
          // 예전 아크릴 틴트는 불투명도에 0.72를 곱해 칠했으므로 보이는 정도가 같게 옮긴다.
          config.opacity = effect === 'solid' ? 100 : effect === 'acrylic' ? Math.round(alpha * .72) : alpha
        }
        delete (config as any).backgroundEffect
        delete (config as any).alphaPercent
        config.uiVersion = DEFAULT_CONFIG.uiVersion
        return config
      }
    } catch (err) {
      console.error('[AccountStore] Failed to load config, using default', err)
    }
    return { ...DEFAULT_CONFIG }
  }

  private loadAccounts(): AccountConfig[] {
    try {
      if (fs.existsSync(this.accountsPath)) {
        const raw = fs.readFileSync(this.accountsPath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length > 0) {
          // 제거된 Google 로그인 기능이 남긴 계정(리프레시 토큰 포함)을 디스크에서 삭제
          const kept = parsed.filter((a: { provider?: string; tokens?: unknown }) => a.provider !== 'google' && !a.tokens)
          const merged = mergeClaudeAccounts(kept)
          if (kept.length !== parsed.length || merged !== kept) {
            this.atomicWriteFileSync(this.accountsPath, JSON.stringify(merged, null, 2))
          }
          return merged.length > 0 ? merged : createDefaultAccounts()
        }
      }
    } catch (err) {
      console.error('[AccountStore] Failed to load accounts, using defaults', err)
    }
    return createDefaultAccounts()
  }

  private atomicWriteFileSync(filePath: string, content: string): void {
    const tmpPath = `${filePath}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(tmpPath, content, 'utf-8')
      fs.renameSync(tmpPath, filePath)
    } catch (err) {
      try {
        fs.writeFileSync(filePath, content, 'utf-8')
      } catch (fallbackErr) {
        console.error(`[AccountStore] Failed to write file ${filePath}:`, fallbackErr)
      }
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
      } catch {}
    }
  }

  public saveConfig(config: WidgetConfig): void {
    this.config = { ...config }
    this.atomicWriteFileSync(this.configPath, JSON.stringify(this.config, null, 2))
  }

  public saveAccounts(accounts: AccountConfig[]): void {
    this.accounts = mergeClaudeAccounts([...accounts])
    this.atomicWriteFileSync(this.accountsPath, JSON.stringify(this.accounts, null, 2))
  }

  public getConfig(): WidgetConfig {
    return { ...this.config }
  }

  public getAccounts(): AccountConfig[] {
    return [...this.accounts]
  }

  public addAccount(account: AccountConfig): void {
    if (account.id === 'local-claude-desktop' && account.provider === 'claude') {
      account = { ...account, id: 'local-claude-code', name: 'Claude Code' }
    }
    const existingIndex = this.accounts.findIndex(a => a.id === account.id)
    if (existingIndex >= 0) {
      this.accounts[existingIndex] = { ...this.accounts[existingIndex], ...account, enabled: true }
    } else {
      this.accounts.push(account)
    }
    this.saveAccounts(this.accounts)
  }

  /** 감지된 로컬 앱을 계정으로 등록. 쿼터는 실시간 조회로만 채운다 (프리셋 숫자를 넣지 않는다) */
  public restoreDetectedAccount(app: DetectedApp): void {
    const acc: AccountConfig = {
      id: app.id,
      name: app.name,
      provider: app.provider as any,
      enabled: true,
      isLocalIde: app.id === 'local-antigravity'
    }

    this.addAccount(acc)
  }

  public resetToDefaultAccounts(): void {
    this.accounts = createDefaultAccounts()
    this.saveAccounts(this.accounts)
  }

  public removeAccount(id: string): void {
    this.accounts = this.accounts.filter(a => a.id !== id)
    this.saveAccounts(this.accounts)
  }

  public toggleAccount(id: string, enabled: boolean): void {
    const target = this.accounts.find(a => a.id === id)
    if (target) {
      target.enabled = enabled
      this.saveAccounts(this.accounts)
    }
  }

  public reorderAccount(id: string, direction: 'up' | 'down'): void {
    const idx = this.accounts.findIndex(a => a.id === id)
    if (idx < 0) return
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= this.accounts.length) return

    const temp = this.accounts[idx]
    this.accounts[idx] = this.accounts[targetIdx]
    this.accounts[targetIdx] = temp
    this.saveAccounts(this.accounts)
  }

  public moveAccount(id: string, beforeId: string | null): void {
    this.saveAccounts(moveAccountBefore(this.accounts, id, beforeId))
  }

  public renameAccount(id: string, name: string): void {
    const clean = name.trim().slice(0, 60)
    if (!clean) return
    this.saveAccounts(this.accounts.map(a => a.id === id ? { ...a, name: clean } : a))
  }

  /** 발견된 Claude 조직을 계정 목록에 맞춘다(규칙은 syncClaudeOrgAccounts). 바뀌었으면 true. */
  public syncClaudeOrgs(orgs: ClaudeOrgSeen[]): boolean {
    const r = syncClaudeOrgAccounts(this.accounts, this.config.claudeOrgsSeen || [], orgs)
    if (!r.changed) return false
    this.saveAccounts(r.accounts)
    this.saveConfig({ ...this.config, claudeOrgsSeen: r.seen })
    return true
  }

  public hideAccount(id: string, hidden: boolean): void {
    this.accounts = this.accounts.map(a => a.id === id ? { ...a, hidden } : a)
    this.saveAccounts(this.accounts)
  }
}
