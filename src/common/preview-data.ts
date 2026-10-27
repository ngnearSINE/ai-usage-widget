import type { AccountUsage, QuotaInfo } from './types.js'

const quota = (left: number, resetInMs: number, countdown: string, now: number): QuotaInfo => ({
  remainingFraction: left / 100, percentLeft: left, percentUsed: 100 - left,
  resetTime: new Date(now + resetInMs).toISOString(), timeUntilResetMs: resetInMs, resetCountdown: countdown,
})
const H = 3600e3, M = 60e3, D = 24 * H

/**
 * 미리보기의 남은 양: 5%부터 93%까지 고르게 퍼진 9개 값을, 앱을 켤 때마다 한도 9칸에 무작위로 섞어 배치한다
 * (막대 색·경고 배경이 여러 단계에서 어떻게 보이는지 한 화면에서 보이게). 한 번 정하면 그 실행 동안은 그대로.
 */
const SPREAD = [5, 16, 27, 38, 49, 60, 71, 82, 93]
function shuffled(): number[] {
  const a = [...SPREAD]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}
let spread: number[] | null = null
/** 앱(미리보기 실행·설정 미리보기)에서 쓰는 무작위 배치. 테스트는 고정 값(previewUsages 기본)을 쓴다. */
export const previewSpread = () => (spread ||= shuffled())
const FIXED = [63, 88, 32, 58, 72, 76, 62, 71, 84]

/** 명시적인 --preview 실행용 합성 데이터. 실제 계정 조회와 분리한다. 리셋 시각을 넣어 페이스·소진 예상도 보이게 한다. */
export function previewUsages(now = Date.now(), values = FIXED): AccountUsage[] {
  const updatedAt = new Date(now).toISOString()
  const [a1, a2, c1, c2, c3, x1, x2, g1, g2] = values
  return [
    { id:'local-antigravity',name:'Antigravity',provider:'antigravity',iconLetter:'A',brandColor:'#83cbb8',status:'ready',tier:'디자인 미리보기',primaryQuota:quota(a1,3*H+28*M,'3시간 28분',now),weeklyQuota:quota(a2,5*D+14*H,'5일 14시간',now),updatedAt },
    { id:'local-claude-code',name:'Claude Code',provider:'claude',iconLetter:'C',brandColor:'#dda98a',status:'ready',tier:'디자인 미리보기',plan:'Team 5x',primaryQuota:quota(c1,2*H+41*M,'2시간 41분',now),weeklyQuota:quota(c2,3*D+9*H,'3일 9시간',now),scopedQuotas:[{label:'Fable',quota:quota(c3,3*D+9*H,'3일 9시간',now)}],updatedAt },
    { id:'local-codex',name:'Codex',provider:'codex',iconLetter:'X',brandColor:'#a99bff',status:'ready',tier:'디자인 미리보기',plan:'Plus',primaryQuota:quota(x1,110*M,'1시간 50분',now),weeklyQuota:quota(x2,4*D+20*H,'4일 20시간',now),updatedAt },
    // 월간 크레딧이 있는 Grok 계정의 모습(첫 칸이 5시간이 아니라 월간).
    { id:'local-grok',name:'Grok',provider:'xai',iconLetter:'G',brandColor:'#A1A1AA',status:'ready',tier:'디자인 미리보기',primaryKind:'monthly',primaryQuota:quota(g1,12*D+6*H,'12일 6시간',now),weeklyQuota:quota(g2,2*D+11*H,'2일 11시간',now),updatedAt },
  ]
}
