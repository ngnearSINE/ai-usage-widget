export function formatCountdown(targetDateOrMs: string | number | undefined): string {
  if (!targetDateOrMs) return '--'

  const targetMs = typeof targetDateOrMs === 'number' 
    ? targetDateOrMs 
    : new Date(targetDateOrMs).getTime()

  if (isNaN(targetMs)) return '--'

  const diffMs = targetMs - Date.now()
  if (diffMs <= 0) return '0m'

  const totalMinutes = Math.floor(diffMs / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  const minutes = totalMinutes % 60

  if (days > 0) {
    return `${days}d ${remainingHours}h`
  }
  if (hours > 0) {
    const padMin = minutes < 10 ? `0${minutes}` : `${minutes}`
    return `${hours}h ${padMin}m`
  }
  return `${minutes}m`
}
