import type { AccountUsage, QuotaInfo } from './types.js'

const quota = (left: number, resetInMs: number, countdown: string, now: number): QuotaInfo => ({
  remainingFraction: left / 100, percentLeft: left, percentUsed: 100 - left,
  resetTime: new Date(now + resetInMs).toISOString(), timeUntilResetMs: resetInMs, resetCountdown: countdown,
})
const H = 3600e3, M = 60e3, D = 24 * H

/** 명시적인 --preview 실행용 합성 데이터. 실제 계정 조회와 분리한다. 리셋 시각을 넣어 페이스·소진 예상도 보이게 한다. */
export function previewUsages(now = Date.now()): AccountUsage[] {
  const updatedAt = new Date(now).toISOString()
  return [
    { id:'local-antigravity',name:'Antigravity',provider:'antigravity',iconLetter:'A',brandColor:'#83cbb8',status:'ready',tier:'디자인 미리보기',primaryQuota:quota(63,3*H+28*M,'3시간 28분',now),weeklyQuota:quota(88,5*D+14*H,'5일 14시간',now),updatedAt },
    { id:'local-claude-code',name:'Claude Code',provider:'claude',iconLetter:'C',brandColor:'#dda98a',status:'ready',tier:'디자인 미리보기',primaryQuota:quota(32,2*H+41*M,'2시간 41분',now),weeklyQuota:quota(58,3*D+9*H,'3일 9시간',now),updatedAt },
    { id:'local-codex',name:'Codex',provider:'codex',iconLetter:'X',brandColor:'#a99bff',status:'ready',tier:'디자인 미리보기',primaryQuota:quota(76,110*M,'1시간 50분',now),weeklyQuota:quota(62,4*D+20*H,'4일 20시간',now),updatedAt },
    // 월간 크레딧이 있는 Grok 계정의 모습(첫 칸이 5시간이 아니라 월간).
    { id:'local-grok',name:'Grok',provider:'xai',iconLetter:'G',brandColor:'#A1A1AA',status:'ready',tier:'디자인 미리보기',primaryKind:'monthly',primaryQuota:quota(71,12*D+6*H,'12일 6시간',now),weeklyQuota:quota(84,2*D+11*H,'2일 11시간',now),updatedAt },
  ]
}
