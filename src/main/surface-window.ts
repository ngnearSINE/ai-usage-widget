import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { type SurfaceKind } from '../common/surface.js'
import { TaskbarDocker } from './taskbar-docker.js'

/**
 * 앱의 모든 창(위젯·팝업·설정)이 상속하는 공통 창. 배경은 Windows Terminal처럼 '불투명도 + 아크릴 켬/끔' 두 값으로 정한다.
 *
 * - backdrop: transparent:false + 투명 배경색 + DWM 아크릴. 아크릴 흐림이 실제로 그려지는 유일한 조합이며,
 *   렌더러가 칠하는 틴트 알파가 곧 불투명도다. 아크릴을 끄고 불투명도 100%여도 이 종류를 쓴다(틴트가 가린다).
 *   작업표시줄에 도킹(child 창)해도 뒤가 그대로 비친다.
 * - layered: transparent:true. 흐림 없이 비치는 반투명은 이 종류로만 그릴 수 있다(아크릴 끔 + 불투명도 100% 미만).
 *
 * 두 종류는 창을 만들 때만 정할 수 있으므로 종류가 바뀌면 창을 다시 만든다(설정을 바꿀 때만 일어난다).
 */
export { surfaceKind, type SurfaceKind } from '../common/surface.js'

export class SurfaceWindow extends BrowserWindow {
  readonly kind: SurfaceKind

  constructor(options: BrowserWindowConstructorOptions, kind: SurfaceKind) {
    super({
      ...options,
      frame: false,
      ...(kind === 'backdrop'
        ? { transparent: false, backgroundColor: '#00000000', backgroundMaterial: 'acrylic' as const }
        : { transparent: true, backgroundColor: '#00000000' })
    })
    this.kind = kind
    // Windows 11은 활성 창에만 아크릴 흐림을 그리고 비활성 창은 단색으로 바꾼다.
    // 위젯처럼 늘 비활성인 창도 흐림을 유지하도록, 보이거나 활성을 잃을 때마다 활성처럼 그리게 한다.
    if (kind === 'backdrop') {
      const keep = () => setTimeout(() => this.keepBackdrop(), 0)
      this.on('show', keep)
      this.on('blur', keep)
      this.once('ready-to-show', keep)
    }
  }

  keepBackdrop() {
    if (this.kind === 'backdrop' && !this.isDestroyed() && this.isVisible()) TaskbarDocker.keepBackdropActive(this)
  }
}
