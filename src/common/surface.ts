import type { WidgetConfig } from './types.js'

/** 창 배경 종류. backdrop은 아크릴을 그릴 수 있는 창, layered는 흐림 없이 비치는 창(자세한 설명은 main/surface-window.ts). */
export type SurfaceKind = 'backdrop' | 'layered'

export const surfaceOpacity = (config: Pick<WidgetConfig, 'opacity'>) => Math.max(0, Math.min(100, Math.round(config.opacity ?? 70)))

export function surfaceKind(config: Pick<WidgetConfig, 'opacity' | 'useAcrylic'>, acrylicSupported: boolean): SurfaceKind {
  if (!acrylicSupported) return 'layered'
  return config.useAcrylic === false && surfaceOpacity(config) < 100 ? 'layered' : 'backdrop'
}
