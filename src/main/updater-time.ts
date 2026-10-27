/** 자동 설치 시각: PC 시계로 기본 새벽 3시, 설정에서 바꿀 수 있다. 잠자기 등으로 늦게 깨어나면 2시간 안에서만 설치하고, 지나면 다음 날로 미룬다. */
export const NIGHTLY_HOUR = 3
const NIGHTLY_WINDOW_HOURS = 2

/** 다음 새벽 3시까지 남은 ms. */
export function msUntilNightly(now: Date, hour = NIGHTLY_HOUR) {
  const next = new Date(now); next.setHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}
/** 지금이 자동 설치해도 되는 시간대(정한 시각부터 2시간, 자정을 넘어도 됨)인지. */
export function inNightlyWindow(now: Date, hour = NIGHTLY_HOUR) { return (now.getHours() - hour + 24) % 24 < NIGHTLY_WINDOW_HOURS }
