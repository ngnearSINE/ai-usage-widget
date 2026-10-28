import type { WidgetConfig } from './types.js'

/** 창 배경 종류. backdrop은 아크릴을 그릴 수 있는 창, layered는 흐림 없이 비치는 창(자세한 설명은 main/surface-window.ts). */
export type SurfaceKind = 'backdrop' | 'layered'

export const surfaceOpacity = (config: Pick<WidgetConfig, 'opacity'>) => Math.max(0, Math.min(100, Math.round(config.opacity ?? 70)))

export function surfaceKind(config: Pick<WidgetConfig, 'opacity' | 'useAcrylic'>, acrylicSupported: boolean): SurfaceKind {
  if (!acrylicSupported) return 'layered'
  // 아크릴을 끄면 불투명도와 상관없이 layered. 불투명도에 따라 종류가 바뀌면 슬라이더를 끄는 동안
  // 흐림이 비치다가 창을 다시 만들며 깜빡이므로, 종류는 아크릴 켬/끔으로만 바뀌게 한다.
  return config.useAcrylic === false ? 'layered' : 'backdrop'
}
