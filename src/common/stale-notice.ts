import type { AccountUsage } from './types.js'

/**
 * 사용량을 새로 받지 못할 때 카드에 붙이는 쉬운 안내. 무슨 일이 생겼는지, 왜 그런지, 무엇을 하면 되는지를 짧게.
 * 서비스가 돌려준 오류 문장을 그대로 보여 주지 않고 흔한 경우를 골라 바꾼다. 모르는 경우는 일반 안내로.
 */
export interface StaleNotice { title: string; reason: string; fix: string }

const has = (msg: string, ...words: string[]) => words.some(w => msg.toLowerCase().includes(w.toLowerCase()))

export function staleNotice(u: Pick<AccountUsage, 'provider' | 'errorMessage' | 'name'>): StaleNotice {
  const msg = u.errorMessage || ''
  if (!msg) return { title: '정확한 값을 잠깐 받지 못했어요', reason: '서비스가 이번에는 대략적인 값만 알려 줬어요.', fix: '따로 할 일은 없어요. 다음 확인 때 저절로 바뀌어요.' }
  if (has(msg, 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'fetch failed', 'network', 'net::', '인터넷', 'timeout', 'timed out', 'aborted'))
    return { title: '인터넷에 연결되지 않았어요', reason: '서비스에 접속하지 못했어요.', fix: '인터넷이 다시 연결되면 저절로 새 값을 받아와요.' }
  if (has(msg, '429', '요청 제한', 'rate limit', '쉬는 중'))
    return { title: '서비스가 잠깐 조회를 막았어요', reason: '짧은 시간에 너무 자주 물어봐서 잠시 쉬라고 했어요.', fix: '몇 분 뒤 저절로 다시 시도해요. 기다리면 돼요.' }
  if (u.provider === 'claude' && has(msg, '로그인 기간'))
    return { title: 'Claude 로그인 기간이 끝났어요', reason: 'Claude Code에 로그인한 지 한 달쯤 지나 다시 로그인해야 해요.', fix: '터미널(명령 프롬프트)에서 claude 를 실행하고 안내대로 다시 로그인해 주세요.' }
  if (u.provider === 'claude' && has(msg, 'CLI 토큰', 'CLI 로그인', 'OAuth 토큰', 'credentials', '로그인 세션 파일'))
    return { title: 'Claude 로그인이 잠시 끊겼어요', reason: '한동안 Claude Code를 쓰지 않아 로그인 시간이 지났어요.', fix: '잠시 기다리면 앱이 자동으로 다시 연결해요. 바로 하려면 터미널에서 claude 를 한 번 실행해 주세요.' }
  if (u.provider === 'claude' && has(msg, '조직의 로그인 정보', 'Claude 앱', '데스크톱'))
    return { title: 'Claude 앱 로그인을 찾지 못했어요', reason: '이 계정으로 로그인된 Claude 앱이나 Claude Code를 찾지 못했어요.', fix: 'Claude 앱을 열어 이 계정으로 한 번 전환하거나, 터미널에서 claude 를 실행해 주세요.' }
  if (u.provider === 'xai' && has(msg, '로그인', 'auth', '만료', '401'))
    return { title: 'Grok 로그인이 끝났어요', reason: 'Grok 로그인 시간이 지났어요.', fix: '터미널에서 grok 을 한 번 실행하면 다시 연결돼요.' }
  if (u.provider === 'codex' && has(msg, '실행 파일', 'not found', '찾을 수 없'))
    return { title: 'Codex를 찾지 못했어요', reason: '이 PC에서 Codex 프로그램을 찾지 못했어요.', fix: 'Codex 앱이나 Codex CLI를 설치하고 로그인해 주세요.' }
  if (u.provider === 'codex' && has(msg, '로그인', 'auth', '401', 'login'))
    return { title: 'Codex 로그인이 끝났어요', reason: 'Codex 로그인 시간이 지났어요.', fix: 'Codex 앱을 열거나 터미널에서 codex login 을 실행해 주세요.' }
  if (u.provider === 'antigravity' && has(msg, 'agy', 'CLI', 'NOT_FOUND'))
    return { title: 'Antigravity를 찾지 못했어요', reason: '이 PC에서 Antigravity 프로그램을 찾지 못했어요.', fix: 'Antigravity를 설치하고 한 번 실행해 로그인해 주세요.' }
  if (has(msg, '401', '403', 'unauthorized', '로그인', 'auth'))
    return { title: '로그인이 끝났어요', reason: `${u.name || '이 서비스'} 로그인 시간이 지났어요.`, fix: '그 서비스의 앱이나 CLI를 한 번 열어 다시 로그인해 주세요.' }
  return { title: '사용량을 새로 받지 못했어요', reason: '서비스에서 이번에는 답을 받지 못했어요.', fix: '잠시 뒤 저절로 다시 시도해요. 계속 이러면 설정 → 서비스에서 이 서비스를 확인해 주세요.' }
}

/** 툴팁 문장(여러 줄). lastAt이 있으면 마지막으로 받은 시각을 붙인다. */
export function staleTip(u: Pick<AccountUsage, 'provider' | 'errorMessage' | 'name' | 'updatedAt'>, now = Date.now(), withLast = true): string {
  const n = staleNotice(u)
  const lines = [`⚠ ${n.title}`, `이유: ${n.reason}`, `이렇게 해 보세요: ${n.fix}`]
  const at = Date.parse(u.updatedAt || '')
  if (withLast && Number.isFinite(at)) {
    const min = Math.max(0, Math.round((now - at) / 60e3))
    const ago = min < 1 ? '방금' : min < 60 ? `${min}분 전` : min < 48 * 60 ? `${Math.floor(min / 60)}시간 전` : `${Math.floor(min / 1440)}일 전`
    const d = new Date(at), p = (x: number) => String(x).padStart(2, '0')
    lines.push(`지금 보이는 값은 ${ago}(${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())})에 받은 마지막 값이에요.`)
  }
  return lines.join('\n')
}
