/**
 * 다음 사용량 조회까지 기다릴 시간(적응형 조회).
 * - 화면이 잠겼거나 한동안 입력이 없으면(idle) 정한 간격의 4배까지 늘린다. 15분보다 길게는 늘리지 않는다(정한 간격이 더 길면 그 간격).
 *   쓰지 않는 동안 서비스에 덜 묻게 해 요청 제한(429)을 줄인다.
 * - 다음 조회보다 먼저 리셋되는 한도가 있으면 리셋 직후(RESET_LAG_MS 뒤)에 묻는다. 리셋된 값이 빨리 보인다.
 */
export const IDLE_FACTOR = 4
export const IDLE_CAP_MS = 15 * 60e3
export const RESET_LAG_MS = 20e3
export const MIN_DELAY_MS = 10e3

export function nextPollDelay(baseMs: number, idle: boolean, resets: number[], now = Date.now()): number {
  const base = Math.max(MIN_DELAY_MS, baseMs)
  let delay = idle ? Math.max(base, Math.min(base * IDLE_FACTOR, IDLE_CAP_MS)) : base
  const soon = resets.filter(t => Number.isFinite(t) && t > now).sort((a, b) => a - b)[0]
  if (soon !== undefined && soon + RESET_LAG_MS - now < delay) delay = soon + RESET_LAG_MS - now
  return Math.max(MIN_DELAY_MS, Math.round(delay))
}
