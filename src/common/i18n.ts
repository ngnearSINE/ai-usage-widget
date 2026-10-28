export type Lang = 'ko' | 'en'

// 시스템 로케일 문자열(예: 'ko-KR', 'en-US')로부터 지원 언어 판별. ko 외에는 전부 영어로 폴백.
export function detectLang(rawLocale: string | undefined | null): Lang {
  return (rawLocale || '').toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

const dict = {
  trayToggleWidget: { ko: '창·작업 표시줄 독 표시/숨김', en: 'Show/Hide Widget' },
  trayOpenPopup: { ko: '위젯 열기', en: 'Open Details' },
  trayAutoLaunch: { ko: 'Windows를 켤 때 함께 시작', en: 'Launch at Login' },
  trayRefreshNow: { ko: '지금 새로고침', en: 'Refresh Now' },
  trayQuit: { ko: '종료', en: 'Quit' },
  trayTooltip: { ko: 'AI 토큰 사용량 위젯', en: 'AI Token Usage Widget' },

  refresh: { ko: '새로고침', en: 'Refresh' },
  close: { ko: '닫기', en: 'Close' },



  statusLoading: { ko: '조회 중', en: 'Loading' },
  statusUnavailable: { ko: '사용량을 가져오지 못했습니다', en: 'Usage unavailable' },

  added: { ko: '✓ 추가됨', en: '✓ Added' },
  redetect: { ko: '다시 감지', en: 'Re-scan' },
  save: { ko: '저장', en: 'Save' },
  cancel: { ko: '취소', en: 'Cancel' },

  iconColor: { ko: '오리지널 컬러', en: 'Original Color' },

  noAccountTitle: { ko: '연결된 AI 계정 없음 (클릭하여 계정 추가 또는 로컬 앱 감지)', en: 'No AI account connected (click to add or auto-detect)' },
  widgetClickTitle: { ko: '한 번 누르면 위젯 열기 · 두 번 누르면 그 카드만 보기(집중 모드)', en: 'Click for details · double-click to focus on one card' }
} satisfies Record<string, Record<Lang, string>>

export type I18nKey = keyof typeof dict

let currentLang: Lang = 'ko'

export function setLang(lang: Lang) {
  currentLang = lang
}

export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  let str = dict[key][currentLang]
  if (vars) {
    for (const k of Object.keys(vars)) {
      str = str.replaceAll(`{${k}}`, String(vars[k]))
    }
  }
  return str
}
