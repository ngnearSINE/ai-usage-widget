import { EN } from './locales/en.js'

/**
 * 화면 언어. 한국어 원문을 그대로 번역 열쇠로 쓴다(코드가 한국어로 읽히고, 새 문구는 감싸기만 하면 된다).
 * - tr('원문 {n}개', { n }) : 지금 언어로 바로 바꾼다(화면·메뉴·알림).
 * - msg('원문 {n}개', { n }) : 한국어 그대로 채운다. 오류 문구처럼 저장·전달된 뒤 화면에서 trText로 바꿀 값에 쓴다.
 *   (안내 판별 등 원문을 읽는 코드가 언어와 상관없이 같은 글자를 보게 된다.)
 * - trText(문구) : msg로 만든 문구를 지금 언어로 바꾼다. 틀({n})이 있는 원문은 모양을 맞춰 값을 옮긴다.
 * 영어 사전은 locales/en.ts. 감싼 원문의 번역이 빠지면 테스트가 실패한다.
 */
export type Lang = 'ko' | 'en'
export type LangSetting = 'system' | Lang
export type Vars = Record<string, string | number>

/** 시스템 언어(예: 'ko-KR', ['en-US','ko'])로부터 지원 언어 판별. 첫 언어가 한국어가 아니면 영어. */
export function detectLang(locales: string | readonly string[] | undefined | null): Lang {
  const first = Array.isArray(locales) ? locales[0] : locales
  return String(first || '').toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

/** 설정값과 시스템 언어로 실제 화면 언어를 정한다. */
export function resolveLang(setting: LangSetting | undefined, system: string | readonly string[] | undefined | null): Lang {
  return setting === 'ko' || setting === 'en' ? setting : detectLang(system)
}

/** 언어 이름은 어느 화면에서든 그 언어로 적는다. */
export const LANG_NAMES: Record<Lang, string> = { ko: '한국어', en: 'English' } // i18n-ok
/** 언어 메뉴 이름. 지금 언어를 못 읽는 사람도 찾도록 두 언어로 적는다. */
export const LANGUAGE_LABEL = '언어 / Language' // i18n-ok

let currentLang: Lang = 'ko'
export function setLang(lang: Lang) { currentLang = lang }
export const getLang = () => currentLang
/** 날짜·숫자 표기용 로케일. */
export const locale = () => currentLang === 'en' ? 'en-US' : 'ko-KR'

const fill = (s: string, vars?: Vars) => vars ? s.replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m) : s

/** 지금 언어로 옮긴다. 번역이 없으면 원문. */
export function tr(ko: string, vars?: Vars): string {
  return fill(currentLang === 'en' ? EN[ko] ?? ko : ko, vars)
}

/** 한국어 원문을 채워 돌려준다(나중에 trText로 옮길 값). */
export function msg(ko: string, vars?: Vars): string {
  return fill(ko, vars)
}

// 틀이 있는 원문을 정규식으로: '{n}분 전' → /^(.+?)분 전$/ 와 변수 이름 목록.
let patterns: { re: RegExp; keys: string[]; ko: string }[] | null = null
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function templates() {
  if (patterns) return patterns
  patterns = Object.keys(EN).filter(k => /\{\w+\}/.test(k)).map(ko => {
    const keys: string[] = []
    const src = ko.split(/(\{\w+\})/).map(part => {
      const m = /^\{(\w+)\}$/.exec(part)
      if (!m) return escapeRe(part)
      keys.push(m[1])
      return '([\\s\\S]+?)'
    }).join('')
    return { re: new RegExp(`^${src}$`), keys, ko }
  }).sort((a, b) => b.ko.length - a.ko.length) // 긴(구체적인) 틀부터
  return patterns
}

/** msg로 만든 한국어 문구를 지금 언어로 바꾼다. 여러 줄은 줄마다 옮긴다. 모르는 문구는 그대로. */
export function trText(text: string | undefined | null): string {
  if (!text) return text ?? ''
  if (currentLang === 'ko') return text
  if (text.includes('\n')) return text.split('\n').map(line => trText(line)).join('\n')
  const exact = EN[text]
  if (exact !== undefined) return exact
  for (const p of templates()) {
    const m = p.re.exec(text)
    if (!m) continue
    const vars: Vars = {}
    p.keys.forEach((k, i) => { vars[k] = trText(m[i + 1]) })
    return fill(EN[p.ko], vars)
  }
  // '개인 · me@x.com'처럼 가운뎃점으로 이은 문구는 조각마다 옮긴다.
  if (text.includes(' · ')) return text.split(' · ').map(part => trText(part)).join(' · ')
  return text
}
