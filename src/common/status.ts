import type { AccountUsage } from './types.js'
import { locale, tr } from './i18n.js'
import { staleNotice } from './stale-notice.js'
import { fmtDuration, paceWarning, windowsOf, type ServiceModel } from './usage-model.js'

/**
 * 카드 상태 하나를 한 곳에서 정한다. 카드 머리의 표시, 연결 안 된 카드, 명령 팔레트, 작업 표시줄·트레이 설명이 같은 판정과 같은 말을 쓴다.
 * 색만으로 구분하지 않도록 늘 글자(label)를 함께 준다.
 *
 * ok 정상 · warn 주의(빠듯하거나 속도가 빠름) · crit 위험 · empty 소진(어느 한도든 0%)
 * stale 갱신 지연(마지막 값을 보여 주는 중) · relogin 다시 로그인 필요 · noquota 한도 정보 없음(이 계정은 볼 수 없음)
 * error 연결 끊김·오류 · loading 확인 중 · offline 연결된 적 없음
 */
export type StatusKind = 'ok' | 'warn' | 'crit' | 'empty' | 'stale' | 'relogin' | 'noquota' | 'error' | 'loading' | 'offline'
export type StatusTone = 'ok' | 'warn' | 'danger' | 'muted'
export interface CardStatus { kind: StatusKind; tone: StatusTone; label: string }

export const STATUS_TONE: Record<StatusKind, StatusTone> = {
  ok: 'ok', warn: 'warn', crit: 'danger', empty: 'danger', stale: 'warn', relogin: 'danger', noquota: 'muted', error: 'muted', loading: 'muted', offline: 'muted',
}

/** 사용량 판정(남은 양·속도)만. 값이 없으면 null. */
export function quotaStatus(m: ServiceModel, warn: number, crit: number, pace = true): StatusKind | null {
  const ws = windowsOf(m)
  if (!m.available || !ws.length) return null
  const low = Math.min(...ws.map(w => w.left))
  if (low <= 0) return 'empty'
  if (low <= crit) return 'crit'
  if (low <= warn || (pace && ws.some(paceWarning))) return 'warn'
  return 'ok'
}

/** 카드 상태. 갱신 지연이어도 마지막 값의 판정(소진·위험)이 더 급하면 그쪽을 앞세운다. */
export function cardStatus(u: AccountUsage, m: ServiceModel, warn: number, crit: number, pace = true): CardStatus {
  const q = quotaStatus(m, warn, crit, pace)
  const low = q ? Math.min(...windowsOf(m).map(w => w.left)) : 0
  const make = (kind: StatusKind, label: string): CardStatus => ({ kind, tone: STATUS_TONE[kind], label })
  if (q === 'empty') return make('empty', tr('소진'))
  if (q === 'crit') return make('crit', tr('여유 {n}%', { n: low }))
  if (q && u.status === 'stale') return make('stale', tr('갱신 지연'))
  if (q === 'warn') return make('warn', low <= warn ? tr('여유 {n}%', { n: low }) : tr('속도 주의'))
  if (q === 'ok') return make('ok', tr('정상'))
  if (u.status === 'loading') return make('loading', tr('확인 중'))
  if (!u.everConnected && u.status !== 'error' && u.status !== 'unauthenticated') return make('offline', tr('연결 안 됨'))
  const kind = staleNotice(u).kind
  if (u.status === 'unauthenticated' || kind === 'login') return make('relogin', tr('다시 로그인 필요'))
  if (kind === 'noquota') return make('noquota', tr('한도 정보 없음'))
  return make('error', u.everConnected ? tr('연결 끊김') : tr('연결 안 됨'))
}

/**
 * 리셋 시각을 실제 시각과 남은 시간으로: '오늘 21:00 · 3시간 20분 후', '내일 09:00 · 14시간 후', '화 21:00 · 2일 7시간 후'.
 * 일주일 넘게 남았으면 날짜를 붙인다('11/18(화) 21:00 · …').
 */
export function resetWhen(ms: number, now = Date.now()): { at: string; left: string; both: string } {
  const d = new Date(now + ms), today = new Date(now)
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400e3)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const dow = d.toLocaleDateString(locale(), { weekday: 'short' })
  const day = dayDiff === 0 ? tr('오늘') : dayDiff === 1 ? tr('내일') : dayDiff < 7 ? dow : `${d.getMonth() + 1}/${d.getDate()}(${dow})`
  const at = `${day} ${hm}`, left = tr('{d} 후', { d: fmtDuration(ms) })
  return { at, left, both: `${at} · ${left}` }
}
