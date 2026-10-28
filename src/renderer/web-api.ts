import type { AppState } from '../common/types.js'

/**
 * 웹 페이지(브라우저)에서 쓰는 window.api. 상태는 앱의 웹 서버에서 읽고(api/state), 바뀌면 받는다(api/events).
 * 그 밖의 모든 기능(설정 바꾸기·새로고침·창 조작 등)은 아무것도 하지 않는다. 웹 페이지는 보기만 한다.
 */
export function installWebApi() {
  const listeners: Array<(s: AppState) => void> = []
  const read = (r: Response) => { if (r.status === 401) { location.reload(); throw new Error('sign-in needed') } return r.json() as Promise<AppState> }
  const known: Record<string, unknown> = {
    getState: () => fetch('api/state', { cache: 'no-store' }).then(read),
    onStateChange: (fn: (s: AppState) => void) => { listeners.push(fn) },
  }
  const events = new EventSource('api/events')
  events.onmessage = e => { const s = JSON.parse(e.data) as AppState; for (const fn of listeners) fn(s) }
  // 앱을 껐다 켜거나 암호가 바뀌어 연결이 끊기면 잠시 뒤 다시 불러온다(암호를 다시 묻게 된다).
  events.onerror = () => { if (events.readyState === EventSource.CLOSED) setTimeout(() => location.reload(), 5000) }
  ;(window as any).api = new Proxy(known, { get: (t, k: string) => k in t ? t[k] : () => Promise.resolve(undefined) })
}
