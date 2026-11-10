import type { AccountUsage } from './types.js'
import { tr } from './i18n.js'

/**
 * 사용량을 새로 받지 못할 때 카드에 붙이는 쉬운 안내. 무슨 일이 생겼는지, 왜 그런지, 무엇을 하면 되는지를 짧게.
 * 서비스가 돌려준 오류 문장을 그대로 보여 주지 않고 흔한 경우를 골라 바꾼다. 모르는 경우는 일반 안내로.
 * 판별은 서비스가 msg()로 만든 한국어 원문을 읽고, 돌려주는 문장은 지금 언어로 옮긴다.
 */
/** 원인 종류: 인터넷·요청 제한·다시 로그인·프로그램 없음·이 계정은 한도를 볼 수 없음·대략적인 값·모름 */
export type StaleKind = 'network' | 'ratelimit' | 'login' | 'missing' | 'noquota' | 'estimate' | 'unknown'
export interface StaleNotice { title: string; reason: string; fix: string; kind: StaleKind }

const has = (msg: string, ...words: string[]) => words.some(w => msg.toLowerCase().includes(w.toLowerCase()))
const notice = (title: string, reason: string, fix: string, kind: StaleKind = 'login'): StaleNotice => ({ title, reason, fix, kind })

export function staleNotice(u: Pick<AccountUsage, 'provider' | 'errorMessage' | 'name'>): StaleNotice {
  const msg = u.errorMessage || ''
  if (!msg) return notice(tr('정확한 값을 잠깐 받지 못했어요'), tr('서비스가 이번에는 대략적인 값만 알려 줬어요.'), tr('따로 할 일은 없어요. 다음 확인 때 저절로 바뀌어요.'), 'estimate')
  if (has(msg, 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'fetch failed', 'network', 'net::', '인터넷', 'timeout', 'timed out', 'aborted')) // i18n-ok
    return notice(tr('인터넷에 연결되지 않았어요'), tr('서비스에 접속하지 못했어요.'), tr('인터넷이 다시 연결되면 저절로 새 값을 받아와요.'), 'network')
  if (has(msg, '429', '요청 제한', 'rate limit', '쉬는 중')) // i18n-ok
    return notice(tr('서비스가 잠깐 조회를 막았어요'), tr('짧은 시간에 너무 자주 물어봐서 잠시 쉬라고 했어요.'), tr('몇 분 뒤 저절로 다시 시도해요. 기다리면 돼요.'), 'ratelimit')
  if (u.provider === 'claude' && has(msg, '로그인 폴더')) // i18n-ok
    return notice(tr('Claude 로그인을 찾지 못했어요'), tr('이 카드의 로그인 폴더에 Claude Code 로그인이 없거나 끝났어요.'), tr('명령 프롬프트에서 set CLAUDE_CONFIG_DIR=그 폴더 를 입력한 뒤 claude 를 실행해 다시 로그인해 주세요.'))
  if (u.provider === 'claude' && has(msg, '로그인 기간')) // i18n-ok
    return notice(tr('Claude 로그인 기간이 끝났어요'), tr('Claude Code에 로그인한 지 한 달쯤 지나 다시 로그인해야 해요.'), tr('터미널(명령 프롬프트)에서 claude 를 실행하고 안내대로 다시 로그인해 주세요.'))
  if (u.provider === 'claude' && has(msg, 'CLI 토큰', 'CLI 로그인', 'OAuth 토큰', 'credentials', '로그인 세션 파일')) // i18n-ok
    return notice(tr('Claude 로그인이 잠시 끊겼어요'), tr('한동안 Claude Code를 쓰지 않아 로그인 시간이 지났어요.'), tr('잠시 기다리면 앱이 자동으로 다시 연결해요. 바로 하려면 터미널에서 claude 를 한 번 실행해 주세요.'))
  if (u.provider === 'claude' && has(msg, '조직의 로그인 정보', 'Claude 앱', '데스크톱')) // i18n-ok
    return notice(tr('Claude 앱 로그인을 찾지 못했어요'), tr('이 계정으로 로그인된 Claude 앱이나 Claude Code를 찾지 못했어요.'), tr('Claude 앱을 열어 이 계정으로 한 번 전환하거나, 터미널에서 claude 를 실행해 주세요.'))
  if (u.provider === 'xai' && has(msg, '자동으로')) // i18n-ok
    return notice(tr('Grok 로그인이 잠시 끊겼어요'), tr('한동안 Grok을 쓰지 않아 로그인 토큰(6시간짜리)이 만료됐어요.'), tr('잠시 기다리면 앱이 자동으로 다시 연결해요. 바로 하려면 터미널에서 grok 을 한 번 실행해 주세요.'))
  if (u.provider === 'xai' && has(msg, '로그인 기간')) // i18n-ok
    return notice(tr('Grok 로그인 기간이 끝났어요'), tr('Grok에 로그인한 지 오래돼 다시 로그인해야 해요.'), tr('터미널에서 grok login 을 실행해 다시 로그인해 주세요.'))
  if (u.provider === 'xai' && has(msg, '로그인', 'auth', '만료', '401')) // i18n-ok
    return notice(tr('Grok 로그인이 끝났어요'), tr('Grok 로그인 시간이 지났어요.'), tr('터미널에서 grok 을 한 번 실행하면 다시 연결돼요.'))
  if (u.provider === 'google' && has(msg, '개인 Google 계정')) // i18n-ok
    return notice(tr('Gemini CLI 한도를 볼 수 없는 계정이에요'), tr('Google이 2026년 6월 18일부터 개인 계정(AI Pro·Ultra 포함)의 Gemini CLI 사용을 끝냈어요.'), `${tr('Antigravity 카드로 사용량을 확인해 주세요.')} ${tr('회사(Workspace)·Code Assist Standard 계정이면 그 계정으로 gemini에 다시 로그인하면 보여요.')}`, 'noquota')
  if (u.provider === 'google' && has(msg, '로그인', '만료', '401')) // i18n-ok
    return notice(tr('Gemini CLI 로그인이 끝났어요'), tr('Gemini CLI 로그인을 찾지 못했거나 만료됐어요.'), tr('터미널에서 gemini 를 한 번 실행해 로그인해 주세요.'))
  if (u.provider === 'cursor' && has(msg, '로그인', '만료', '401')) // i18n-ok
    return notice(tr('Cursor 로그인이 끝났어요'), tr('Cursor 앱의 로그인을 찾지 못했거나 만료됐어요.'), tr('Cursor 앱을 열어 로그인해 주세요.'))
  if (u.provider === 'copilot' && has(msg, '로그인', '만료', '401')) // i18n-ok
    return notice(tr('GitHub 로그인이 필요해요'), tr('Copilot을 확인할 GitHub 로그인을 찾지 못했거나 만료됐어요.'), tr('편집기에서 Copilot에 로그인하거나 터미널에서 gh auth login 을 해 주세요.'))
  if (u.provider === 'codex' && has(msg, '실행 파일', 'not found', '찾을 수 없')) // i18n-ok
    return notice(tr('Codex를 찾지 못했어요'), tr('이 PC에서 Codex 프로그램을 찾지 못했어요.'), tr('Codex 앱이나 Codex CLI를 설치하고 로그인해 주세요.'), 'missing')
  if (u.provider === 'codex' && has(msg, '로그인', 'auth', '401', 'login')) // i18n-ok
    return notice(tr('Codex 로그인이 끝났어요'), tr('Codex 로그인 시간이 지났어요.'), tr('Codex 앱을 열거나 터미널에서 codex login 을 실행해 주세요.'))
  if (u.provider === 'antigravity' && has(msg, 'agy', 'CLI', 'NOT_FOUND'))
    return notice(tr('Antigravity를 찾지 못했어요'), tr('이 PC에서 Antigravity 프로그램을 찾지 못했어요.'), tr('Antigravity를 설치하고 한 번 실행해 로그인해 주세요.'), 'missing')
  if (has(msg, '401', '403', 'unauthorized', '로그인', 'auth')) // i18n-ok
    return notice(tr('로그인이 끝났어요'), tr('{name} 로그인 시간이 지났어요.', { name: u.name || tr('이 서비스') }), tr('그 서비스의 앱이나 CLI를 한 번 열어 다시 로그인해 주세요.'))
  return notice(tr('사용량을 새로 받지 못했어요'), tr('서비스에서 이번에는 답을 받지 못했어요.'), tr('잠시 뒤 저절로 다시 시도해요. 계속 이러면 설정 → 서비스에서 이 서비스를 확인해 주세요.'), 'unknown')
}

/** '방금'·'N분 전' 같은 지난 시간(분 단위 입력). */
export function agoText(min: number): string {
  return min < 1 ? tr('방금') : min < 60 ? tr('{n}분 전', { n: min }) : min < 48 * 60 ? tr('{n}시간 전', { n: Math.floor(min / 60) }) : tr('{n}일 전', { n: Math.floor(min / 1440) })
}

/** 툴팁 문장(여러 줄). lastAt이 있으면 마지막으로 받은 시각을 붙인다. */
export function staleTip(u: Pick<AccountUsage, 'provider' | 'errorMessage' | 'name' | 'updatedAt'>, now = Date.now(), withLast = true): string {
  const n = staleNotice(u)
  const lines = [`⚠ ${n.title}`, tr('이유: {reason}', { reason: n.reason }), tr('이렇게 해 보세요: {fix}', { fix: n.fix })]
  const at = Date.parse(u.updatedAt || '')
  if (withLast && Number.isFinite(at)) {
    const min = Math.max(0, Math.round((now - at) / 60e3))
    const d = new Date(at), p = (x: number) => String(x).padStart(2, '0')
    lines.push(tr('지금 보이는 값은 {ago}({date} {time})에 받은 마지막 값이에요.', { ago: agoText(min), date: `${d.getMonth() + 1}/${d.getDate()}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` }))
  }
  return lines.join('\n')
}
