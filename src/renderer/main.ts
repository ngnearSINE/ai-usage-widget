import { renderAiIcon } from './components/ai-icons.js'
import type { AccountUsage, AppState, WidgetConfig } from '../common/types.js'
import { detectLang, setLang, t } from '../common/i18n.js'
import { applyAppearance, renderDashboard, renderDockedUsage, setPopupSurface } from './components/dashboard.js'
import { initSettings, renderSettings } from './components/settings-view.js'
import { renderAbout } from './components/about-view.js'
import { visibleUsages } from '../common/widget-layout.js'
import { lowestLeft, serviceModel } from '../common/usage-model.js'

/** 트레이 아이콘에 가장 빠듯한 남은 %를 그린다. 메인 프로세스에는 캔버스가 없어 위젯 화면이 그려서 보낸다. */
let lastTrayKey = ''
function updateTrayIcon(state: AppState) {
  const c = state.config
  const list = visibleUsages(state.usages, state.accounts, c).filter(u => ['ready', 'stale'].includes(u.status)).map(u => ({ u, m: serviceModel(u) }))
  const tight = list.sort((a, b) => lowestLeft(a.m) - lowestLeft(b.m))[0]
  const tooltip = list.length ? `AI 사용량 · ${list.map(({ u, m }) => `${u.name} ${lowestLeft(m)}%`).join(' · ')}` : 'AI 사용량'
  if (c.trayShowNumber === false || !tight) {
    if (lastTrayKey !== 'default') { lastTrayKey = 'default'; window.api.setTrayImage?.(null, tooltip) }
    return
  }
  const value = lowestLeft(tight.m), warn = c.warnPercent ?? 20, crit = Math.min(warn, c.critPercent ?? 10)
  const bg = value <= crit ? '#ff6b73' : value <= warn ? '#f0b65a' : (/^#[\da-f]{6}$/i.test(c.accentColor || '') ? c.accentColor! : '#8cbbff')
  const key = `${value}|${bg}|${tooltip}`
  if (key === lastTrayKey) return
  lastTrayKey = key
  const size = 32, canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  g.fillStyle = bg
  g.beginPath(); g.roundRect(1, 1, size - 2, size - 2, 7); g.fill()
  const text = value >= 100 ? '100' : String(value)
  g.fillStyle = '#16151d'
  g.font = `700 ${text.length >= 3 ? 14 : 19}px "Segoe UI Variable Display","Segoe UI",sans-serif`
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(text, size / 2, size / 2 + 1)
  window.api.setTrayImage?.(canvas.toDataURL('image/png'), tooltip)
}
import { initTooltips } from './components/tooltip.js'
import './dashboard.css'

initTooltips()

// title 속성에 들어가는 계정명/에러문구는 외부 프로세스 출력이거나 사용자 입력이다
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}

const lang = detectLang(navigator.language)
setLang(lang)
document.documentElement.lang = lang

const urlParams = new URLSearchParams(window.location.search)
const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
const viewType = urlParams.get('view') || hashParams.get('view') || (window.location.hash.includes('popup') ? 'popup' : 'widget')
const dockPreview = viewType === 'dock-preview'
if (dockPreview) {
  document.body.classList.add('is-dock-preview')
  document.documentElement.style.setProperty('--dock-preview-height',`${Math.max(24,Math.min(160,Number(urlParams.get('dockHeight'))||48))}px`)
}
const appEl = document.getElementById('app')!

if (viewType === 'popup') {
  document.body.classList.add('is-popup-view', 'is-dashboard-view')
  setPopupSurface(true)
} else if (viewType === 'settings' || viewType === 'about') {
  document.body.classList.add('is-settings-view')
} else {
  document.body.classList.add('is-widget-view')
}

let lastWidgetHtml = ''
let lastSentWidth = 0
let lastSentHeight = 0

function updateRootAlpha(opacity: number) {
  const alpha = Math.max(0, Math.min(1.0, opacity / 100))
  document.documentElement.style.setProperty('--bg-alpha', alpha.toString())
}

function updateVerticalOffset(offsetPx?: number) {
  document.documentElement.style.setProperty('--vertical-offset', `${offsetPx || 0}px`)
}

// 쿼터 숫자 대신 상태만 보여준다 (숫자를 그리면 실패가 "여유 있음"으로 읽힌다)
function renderUnavailable(u: AccountUsage, config: WidgetConfig): string {
  const iconHtml = renderAiIcon(u.provider, u.name, config.iconStyle, 18)
  const loading = u.status === 'loading'
  const tooltip = escapeHtml(`${u.name}: ${loading ? t('statusLoading') : (u.errorMessage || t('statusUnavailable'))}`)
  return `
    <div class="account-item is-unavailable ${loading ? 'is-loading' : ''}" data-account-id="${escapeHtml(u.id)}" title="${tooltip}">
      ${iconHtml}
      <span class="unavailable-mark">${loading ? '···' : '!'}</span>
    </div>
  `
}

function renderWidget(state: AppState) {
  if (dockPreview) state={...state,config:{...state.config,placementMode:'docked'}}
  else updateTrayIcon(state)
  applyAppearance(state.config)
  const floating = state.config.placementMode !== 'docked'
  document.body.classList.toggle('is-dashboard-view', floating)
  if (floating) {
    lastWidgetHtml = ''
    lastSentWidth = 0
    lastSentHeight = 0
    renderDashboard(appEl, state)
    return
  }
  updateRootAlpha(state.config.opacity ?? 70)
  updateVerticalOffset(state.config.verticalOffsetPx)

  const allDocked = visibleUsages(state.usages, state.accounts, state.config, true)
  const activeUsages = state.focus && state.usages.some(u => u.id === state.focus) ? state.usages.filter(u => u.id === state.focus) : allDocked
  const isEmpty = activeUsages.length === 0
  let accountsHtml = ''

  if (isEmpty) {
    // 연결된 계정이 없을 때: 하얀색 작은 동그라미 더미 아이콘 표시
    accountsHtml = `
      <div class="white-circle-dot" title="${t('noAccountTitle')}"></div>
    `
  } else {
    accountsHtml = activeUsages.map((u) => {
      // 테마는 status 를 보지 않으므로, 실측값이 없는 계정을 그대로 넘기면 "100% 남음"이 표시된다.
      // 4개 테마를 각각 고치는 대신 진입점에서 한 번 걸러낸다.
      if (u.status === 'error' || u.status === 'unauthenticated' || u.status === 'loading') {
        return renderUnavailable(u, state.config)
      }
      return renderDockedUsage(u,state.config)
    }).join('')
  }

  const showCard = state.config.showCardBackground ?? false
  const newHtml = `
    <div class="widget-root ${isEmpty ? 'is-empty' : ''} ${showCard ? 'has-card-bg' : 'no-card-bg'}" id="widget-container" title="${t('widgetClickTitle')}">
      <span class="dock-grip" title="끌어내면 자유 창으로 전환됩니다">⠿</span>
      ${accountsHtml}
    </div>
  `

  // 내용 또는 스타일 설정 변경 시에만 DOM 교체하여 깜빡임 방지
  const renderSignature = `${newHtml}_${showCard}_${state.config.theme}_${state.config.iconStyle}`
  if (renderSignature !== lastWidgetHtml) {
    lastWidgetHtml = renderSignature
    appEl.innerHTML = newHtml

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = document.getElementById('widget-container')
        if (container) {
          const rect = container.getBoundingClientRect()
          const naturalWidth = Math.max(rect.width, container.scrollWidth)
          const width = Math.ceil(naturalWidth)
          const height = window.innerHeight
          if (width !== lastSentWidth || height !== lastSentHeight) {
            lastSentWidth = width
            lastSentHeight = height
            if (!dockPreview) window.api.resizeWidget(width, height)
          }
        }
      })
    })
  }
}

function renderPopup(state: AppState, animate = false) {
  renderDashboard(appEl, state, animate)
  if (!animate) return
  // 열릴 때마다 아래에서 올라오는 등장 효과
  const root = appEl.querySelector<HTMLElement>('.dashboard')
  root?.classList.remove('popup-enter'); void root?.offsetWidth; root?.classList.add('popup-enter')
}

// 브라우저 직접 접근 및 E2E 테스트 지원을 위한 Mock API
if (!(window as any).api) {
  let mockState: AppState = {
    config: {
      theme: '1b',
      iconStyle: 'color',
      alignment: 'right',
      offsetPx: 20,
      verticalOffsetPx: 0,
      refreshIntervalSec: 60,
      opacity: 70,
      useAcrylic: true,
      showWeeklyLimit: true,
      colorByUsage: true,
      showCardBackground: false,
      placementMode: 'floating', uiVersion: 2, appearance: 'dark', barStyle: 'silk', accentColor: '#8cbbff', motion: 'subtle', hideDisconnected: true
    },
    accounts: [
      { id: 'local-antigravity', name: 'Google Antigravity', provider: 'antigravity', enabled: true },
      { id: 'local-claude-code', name: 'Claude Code', provider: 'claude', enabled: true },
      { id: 'local-codex', name: 'Codex CLI', provider: 'codex', enabled: true }
    ],
    usages: [
      {
        id: 'local-antigravity',
        name: 'Antigravity (Local IDE)',
        provider: 'antigravity',
        iconLetter: 'A',
        brandColor: '#2563EB',
        status: 'ready',
        primaryQuota: { remainingFraction: 0.63, percentLeft: 63, percentUsed: 37, resetCountdown: '3h 28m' },
        weeklyQuota: { remainingFraction: 0.88, percentLeft: 88, percentUsed: 12, resetCountdown: '5d 14h' },
        updatedAt: new Date().toISOString()
      },
      {
        id: 'local-claude-code',
        name: 'Claude Code',
        provider: 'claude',
        iconLetter: 'C',
        brandColor: '#D97757',
        status: 'ready',
        primaryQuota: { remainingFraction: 0.32, percentLeft: 32, percentUsed: 68, resetCountdown: '2h 41m' },
        weeklyQuota: { remainingFraction: 0.58, percentLeft: 58, percentUsed: 42, resetCountdown: '3d 9h' },
        updatedAt: new Date().toISOString()
      },
      {
        id: 'local-codex',
        name: 'Codex CLI',
        provider: 'codex',
        iconLetter: 'X',
        brandColor: '#6366F1',
        status: 'ready',
        primaryQuota: { remainingFraction: 0.46, percentLeft: 46, percentUsed: 54, resetCountdown: '1h 50m' },
        weeklyQuota: { remainingFraction: 0.62, percentLeft: 62, percentUsed: 38, resetCountdown: '4d 20h' },
        updatedAt: new Date().toISOString()
      }
    ],
    isRefreshing: false,
    lastRefreshedAt: new Date().toISOString()
  }

  const listeners: ((s: AppState) => void)[] = []
  ;(window as any).api = {
    getState: async () => mockState,
    updateConfig: async (patch: any) => {
      mockState = { ...mockState, config: { ...mockState.config, ...patch } }
      listeners.forEach((fn) => fn(mockState))
      return mockState
    },
    refreshQuota: async () => mockState,
    addCustomAccount: async () => mockState,
    restoreDetectedApp: async (app: any) => {
      if (!mockState.accounts.some(a => a.id === app.id)) {
        mockState.accounts.push({ id: app.id, name: app.name, provider: app.provider, enabled: true })
      }
      listeners.forEach((fn) => fn(mockState))
      return mockState
    },
    resetDefaultAccounts: async () => {
      mockState.accounts = [
        { id: 'local-antigravity', name: 'Google Antigravity', provider: 'antigravity', enabled: true },
        { id: 'local-claude-code', name: 'Claude Code', provider: 'claude', enabled: true },
        { id: 'local-codex', name: 'Codex CLI', provider: 'codex', enabled: true }
      ]
      listeners.forEach((fn) => fn(mockState))
      return mockState
    },
    toggleAccount: async () => mockState,
    hideAccount: async (id: string, hidden: boolean) => {
      mockState.accounts = mockState.accounts.map(a => a.id === id ? {...a,hidden} : a)
      listeners.forEach(fn => fn(mockState)); return mockState
    },
    moveAccount: async (id: string, beforeId: string | null) => {
      const moving = mockState.accounts.find(a => a.id === id)!
      mockState.accounts = mockState.accounts.filter(a => a.id !== id)
      mockState.accounts.splice(beforeId ? mockState.accounts.findIndex(a => a.id === beforeId) : mockState.accounts.length,0,moving)
      listeners.forEach(fn => fn(mockState)); return mockState
    },
    beginInteraction: async () => {},
    endInteraction: async () => {},
    moveInteraction: () => {},
    hideWidget: async () => {},
    removeAccount: async (id: string) => {
      mockState.accounts = mockState.accounts.filter(a => a.id !== id)
      listeners.forEach((fn) => fn(mockState))
      return mockState
    },
    reorderAccount: async (id: string, direction: 'up' | 'down') => {
      const idx = mockState.accounts.findIndex(a => a.id === id)
      if (idx >= 0) {
        const targetIdx = direction === 'up' ? idx - 1 : idx + 1
        if (targetIdx >= 0 && targetIdx < mockState.accounts.length) {
          const temp = mockState.accounts[idx]
          mockState.accounts[idx] = mockState.accounts[targetIdx]
          mockState.accounts[targetIdx] = temp
        }
      }
      // usages 순서도 계정 순서와 일치하도록 동기화
      const sortedUsages: any[] = []
      for (const acc of mockState.accounts) {
        const u = mockState.usages.find(item => item.id === acc.id || item.name.toLowerCase().includes(acc.name.toLowerCase().split(' ')[0]))
        if (u) sortedUsages.push(u)
      }
      mockState.usages = sortedUsages
      listeners.forEach((fn) => fn(mockState))
      return mockState
    },
    hidePopup: () => console.log('[MockAPI] hidePopup'),
    unlockPopup: () => console.log('[MockAPI] unlockPopup'),
    resizeWidget: (w: number, h: number) => console.log(`[MockAPI] resizeWidget: ${w}x${h}`),
    openSettings: () => console.log('[MockAPI] openSettings'),
    detectLocalApps: async () => [
      { id: 'local-antigravity', name: 'Google Antigravity', provider: 'antigravity', running: true, installed: true, brandColor: '#2563EB' },
      { id: 'local-claude-code', name: 'Claude Code', provider: 'claude', running: true, installed: true, brandColor: '#D97757' },
      { id: 'local-codex', name: 'Codex CLI', provider: 'codex', running: false, installed: true, brandColor: '#6366F1' }
    ],
    popupReady: () => {},
    onPopupOpened: () => {},
    onStateChange: (fn: (s: AppState) => void) => {
      listeners.push(fn)
    }
  }
}

async function init() {
  // 클릭 리스너는 state를 필요로 하지 않으므로, 창이 화면에 보이자마자(getState
  // IPC 왕복을 기다리기 전에) 먼저 붙여둔다. 개발 모드(Vite dev server)는 번들이
  // 아니라 개별 모듈을 네트워크로 받아오는 방식이라 이 왕복이 느려질 수 있는데,
  // 그 사이에 창은 이미 떠 있어서 클릭해도 반응이 없는 것처럼 보이는 문제를 줄인다.
  if (viewType === 'popup') {
  }

  const state = await window.api.getState()

  if (viewType === 'about') {
    renderAbout(appEl, state)
    window.api.onStateChange((nextState) => renderAbout(appEl, nextState))
    return
  }
  if (viewType === 'settings') {
    initSettings(appEl, state, urlParams.get('tab') || undefined)
    window.api.onStateChange((nextState) => renderSettings(nextState))
    return
  }

  if (viewType === 'popup') {
    renderPopup(state)
    window.api.onStateChange((nextState) => {
      renderPopup(nextState)
    })
    // 메인이 팝업을 투명하게 띄운 상태: 등장 애니메이션 첫 프레임이 화면에 반영된 뒤 불투명 전환 요청
    window.api.onPopupOpened((nextState) => {
      renderPopup(nextState, true)
      requestAnimationFrame(() => requestAnimationFrame(() => window.api.popupReady()))
    })
  } else {
    renderWidget(state)
    window.api.onStateChange((nextState) => {
      renderWidget(nextState)
    })
  }
}

init().catch((err) => {
  console.error('[Renderer] Init error:', err)
})
