/** 자동 설치 시각: PC 시계로 새벽 3시. 잠자기 등으로 늦게 깨어나면 5시 전까지만 설치하고, 지나면 다음 날로 미룬다. */
export const NIGHTLY_HOUR = 3
const NIGHTLY_UNTIL_HOUR = 5

/** 다음 새벽 3시까지 남은 ms. */
export function msUntilNightly(now: Date, hour = NIGHTLY_HOUR) {
  const next = new Date(now); next.setHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}
/** 지금이 자동 설치해도 되는 시간대(3시~5시 전)인지. */
export function inNightlyWindow(now: Date) { const h = now.getHours(); return h >= NIGHTLY_HOUR && h < NIGHTLY_UNTIL_HOUR }
