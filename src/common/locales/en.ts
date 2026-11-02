import { EN_CORE } from './en/core.js'
import { EN_SETTINGS } from './en/settings.js'
import { EN_DASHBOARD } from './en/dashboard.js'
import { EN_COMMON } from './en/common.js'
import { EN_MAIN } from './en/main.js'
import { EN_SERVICES } from './en/services.js'

/** 영어 사전. 화면 영역별 파일을 합친다(같은 원문이 여러 파일에 있으면 뒤의 것이 이긴다 — 테스트가 서로 다른 번역을 막는다). */
export const EN_PARTS: Record<string, Record<string, string>> = { core: EN_CORE, settings: EN_SETTINGS, dashboard: EN_DASHBOARD, common: EN_COMMON, main: EN_MAIN, services: EN_SERVICES }
export const EN: Record<string, string> = Object.assign({}, ...Object.values(EN_PARTS))
