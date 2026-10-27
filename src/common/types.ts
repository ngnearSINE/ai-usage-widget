export type ThemeType = '1a' | '1b' | '1c' | '1d'
export type IconStyle = 'color' | 'monochrome'
export type PositionAlignment = 'right' | 'left'
export type ProviderType = 'google' | 'claude' | 'mistral' | 'xai' | 'openai' | 'antigravity' | 'codex' | 'custom'

export interface QuotaInfo {
  remainingFraction: number // 0.0 ~ 1.0 (남은 비율)
  percentLeft: number // 0 ~ 100% (남은 비율 %)
  percentUsed: number // 0 ~ 100% (사용한 비율 %)
  resetTime?: string // ISO date
  resetCountdown: string // "2h 41m", "3d 9h", "47m"
  timeUntilResetMs?: number
  isExhausted?: boolean
}

export interface ModelQuotaDetail {
  modelId: string
  displayName: string
  quota: QuotaInfo
}

export interface AccountUsage {
  everConnected?: boolean // 한 번이라도 값을 받은 적 있는 계정(연결이 끊겨도 숨기지 않음)
  pending?: boolean // 앱을 막 켜서 마지막 값을 먼저 보여 주며 새 값을 확인하는 중
  id: string
  name: string
  provider: ProviderType
  iconLetter: string // C, G, M, X 등
  brandColor: string // #FF6B4A, #4285F4, #00D1B2, #D946EF 등
  email?: string
  tier?: string
  plan?: string // 플랜 배지(예: Team, Max 20x, Pro, Plus)
  dataSource?: 'claude-cli' | 'claude-desktop' | 'claude-desktop-live'
  projectId?: string
  // 'stale' = 마지막 성공 실측값을 그대로 보여주는 중 (갱신 실패). updatedAt은 그 실측 시각을 유지한다
  status: 'ready' | 'loading' | 'error' | 'unauthenticated' | 'stale'
  errorMessage?: string
  // 실측이 아니라 추정/수동 입력값임을 표시 (Codex SQLite 토큰 추정, 사용자가 직접 넣은 custom 계정)
  isEstimated?: boolean
  primaryQuota: QuotaInfo // 5시간 또는 기본 한도
  weeklyQuota?: QuotaInfo // 주간 한도
  isWeeklyOnly?: boolean // ChatGPT Pro 등 5시간 세션 쿼터 없이 1주일 쿼터만 존재하는 계정 여부
  primaryKind?: 'monthly' // 기본 한도가 5시간이 아니라 월간 크레딧인 계정(Grok)
  scopedQuotas?: Array<{ label: string; quota: QuotaInfo }> // 모델 전용 주간 한도(예: Claude 팀의 Fable). 주간 한도 안의 별도 몫
  barColor?: string // 계정 설정의 평소 색을 CSS 색으로 푼 값(ownColor). 없으면 서비스 색
  scopedHidden?: string[] // 계정 설정으로 숨긴 모델 전용 한도 이름(설정 화면이 스위치를 보여 주는 데 쓴다)
  models?: ModelQuotaDetail[]
  updatedAt: string
}

export interface AccountConfig {
  id: string
  name: string
  provider: ProviderType
  enabled: boolean
  hidden?: boolean
  isLocalIde?: boolean
  orgUuid?: string // Claude 조직(팀/개인). 있으면 그 조직 토큰으로 조회한다
  showScoped?: boolean // 모델 전용 한도(Fable 등) 보기. 기본 켬
  hiddenInDock?: boolean // 작업표시줄 도킹 화면에서만 숨김. 위젯 창에는 보인다
  homeDir?: string // 두 번째 계정: 그 서비스 CLI의 로그인 폴더(Codex CODEX_HOME, Grok GROK_HOME)
  barColor?: string // 그래프 평소 색: 없음=서비스 색, 'green', '#rrggbb'
  customMock?: {
    primaryPercent: number
    primaryReset: string
    weeklyPercent: number
    weeklyReset: string
    isWeeklyOnly?: boolean
    iconLetter?: string
    brandColor?: string
  }
}

/** 경고 배경을 진하게 칠할 한쪽 방향 */
export type HeatSide = 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface WidgetConfig {
  theme: ThemeType // '1a' | '1b' | '1c' | '1d'
  iconStyle: IconStyle // 'color' | 'monochrome'
  alignment: PositionAlignment // 'right' | 'left'
  offsetPx: number // 트레이 또는 모서리로부터 떨어진 거리 (기본 16px)
  verticalOffsetPx: number // 작업표시줄 상하 미세조정 (기본 0px)
  refreshIntervalSec: number // 갱신 주기 (기본 60초)
  showWeeklyLimit: boolean
  colorByUsage: boolean // 사용량에 따른 색상 변화 (안전:그린 -> 주의:오렌지 -> 위험:레드)
  displayByAccount?: Record<string, Partial<Record<'showUsed' | 'showPace' | 'showReset', boolean>>> // 서비스별 보여 줄 정보
  notifyQuiet?: { enabled: boolean; start: string; end: string } // 알림 쉬는 시간(HH:MM, 자정을 넘을 수 있음). 그 사이 알림은 건너뜀
  popupBounds?: { x: number; y: number; width: number; height: number } // 작업 표시줄 팝업 위치·크기(옮기거나 키우면 기억)
  warnTint?: boolean // 경고 배경 색(기본 켬)
  warnTintLevel?: 'soft' | 'medium' | 'strong' // (예전) 세기 단계. warnTintStrength로 대체
  warnTintStrength?: number // 세기 0~100(기본 30)
  warnTintSpread?: number // 퍼짐 0~100(기본 30 = 진한 곳에 모임, 올릴수록 카드 전체로)
  warnTintOrigin?: 'edge' | 'center' | 'side' | 'corners' | 'corner' // 진한 곳(기본 테두리). corners·corner는 예전 값
  warnTintSide?: HeatSide // '한쪽'일 때 방향(기본 왼쪽 위)
  autoUpdate?: boolean // 새 버전 자동 확인·다운로드(기본 켬, 설치판만)
  updateHour?: number // 자동 설치 시각(PC 시각 0~23시, 기본 3시)
  colorMode?: 'step' | 'smooth' // 경고색으로 바뀌는 방식: 기준에서 한 번에(기본) / 남은 양에 따라 부드럽게
  showUsedPercent?: boolean // true: 소모량(%) 표시, false/미설정: 남은량(%) 표시 (작업표시줄 바)
  placementMode?: 'docked' | 'floating' // 작업표시줄 내부 도킹 vs 작업표시줄 바로 위 플로팅
  alwaysOnTop?: boolean // '작업 표시줄 바로 위' 플로팅 모드 시 항상 위에 표시 여부 (기본: true)
  showCardBackground?: boolean // 배경 카드 박스 표시 여부 (false 시 완전 투명/작업표시줄 일체화)
  openAtLogin?: boolean // 윈도우 시작 시 자동 실행
  doubleClickToOpenPopup?: boolean // true면 위젯 더블클릭으로만 상세 팝업 열기 (기본 false)
  apiPushEnabled?: boolean // 쿼터 갱신 시 사용량을 apiEndpoint 로 POST (기본 false)
  apiEndpoint?: string // 기본 http://localhost:8080/api/usage
  apiScreen?: number // 페이로드의 screen 번호 (기본 1)
  uiVersion?: number
  windowBounds?: { x: number; y: number; width: number; height: number }
  appearance?: 'dark' | 'light' | 'system'
  barStyle?: 'silk' | 'aurora' | 'neon' | 'segments' | 'mono' | 'spectrum'
  motion?: 'off' | 'subtle' | 'expressive'
  accentColor?: string
  fontScale?: number
  cardGap?: number
  hideDisconnected?: boolean
  showResetTime?: boolean
  showServiceName?: boolean
  opacity?: number // 모든 창 배경 불투명도 0~100 (Windows Terminal과 같은 뜻, 기본 70)
  useAcrylic?: boolean // 배경 뒤를 흐리게(아크릴). 끄면 흐림 없이 비친다 (기본 켬)
  grokOffered?: boolean // 기존 계정 목록에 Grok을 한 번 추가했는지
  claudeOrgsSeen?: string[] // 이미 카드로 추가했던 Claude 조직(지운 뒤 다시 넣지 않도록)
  design?: 'rich' | 'numeral' | 'bars' | 'rings' | 'timeline' | 'battery'
  valueSource?: Record<string, 'weekly' | '5h' | 'tight'> // 계정별 큰 숫자 기준 (기본 주간)
  warnPercent?: number // 남은 양이 이 값 이하이면 주의 (기본 20)
  critPercent?: number // 남은 양이 이 값 이하이면 위험 (기본 10)
  showPace?: boolean // '예상 시간': 페이스 눈금·속도 칩·소진 예상 문구
  sortLowFirst?: boolean // 여유가 적은 서비스를 앞으로
  notifyEnabled?: boolean // Windows 알림 전체 (기본 켬)
  notifyLow?: boolean // 주의·위험 기준 도달 알림 (기본 켬)
  notifyPace?: boolean // 리셋 전 소진 예상 알림 (기본 켬)
  notifyReset?: boolean // 빠듯했던 한도가 새로 채워지면 알림 (기본 끔)
  notifyMuted?: string[] // 알리지 않을 '계정ID:5h|weekly' 목록
  notifyUnused?: boolean // 주간 리셋이 임박했는데 많이 남았을 때 안내 (기본 켬)
  trayShowNumber?: boolean // 트레이 아이콘에 가장 빠듯한 남은 % 표시 (기본 켬)
  clickThrough?: boolean // 클릭 통과 잠금: 위젯 위 클릭이 뒤 창으로 간다 (자유 창 전용)
  shortcuts?: { toggle?: string; lock?: string; cycle?: string } // 전역 단축키(빈 문자열 = 끔)
  rememberPerMonitor?: boolean // 모니터 구성마다 위치·크기·디자인 기억 (기본 켬)
  layoutsByMonitor?: Record<string, { windowBounds?: { x: number; y: number; width: number; height: number }; design?: WidgetConfig['design'] }>
}

/** 사용 기록 한 점: [시각(ms), 5시간 남은 %, 주간 남은 %]. 없는 한도는 null. */
export type HistoryPoint = [number, number | null, number | null]

/** 자동 업데이트 상태. unsupported는 휴대용 zip·개발 실행처럼 스스로 업데이트할 수 없는 경우. */
export interface UpdateState {
  status: 'unsupported' | 'idle' | 'checking' | 'downloading' | 'ready' | 'latest' | 'error'
  version?: string
  percent?: number
  message?: string
  checkedAt?: string
}

export interface AppState {
  preview?: boolean
  focus?: string // 집중 모드로 보고 있는 계정(일시적, 저장하지 않음)
  update?: UpdateState
  version?: string // 앱 버전(설정 창 '정보')
  guideAvailable?: boolean // 사용 설명서 PDF를 열 수 있는지
  acrylicSupported?: boolean
  dockSupported?: boolean // 작업 표시줄 도킹 가능(Windows만)
  config: WidgetConfig
  accounts: AccountConfig[]
  usages: AccountUsage[]
  isRefreshing: boolean
  lastRefreshedAt: string
  history?: Record<string, HistoryPoint[]> // 최근 24시간(카드 추이선용, 줄여서 보냄)
  shortcutErrors?: string[] // 등록하지 못한 단축키(다른 앱이 사용 중 등)
}
