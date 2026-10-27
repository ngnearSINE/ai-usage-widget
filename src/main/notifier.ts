import fs from 'node:fs'
import path from 'node:path'
import { Notification } from 'electron'
import type { AccountUsage, WidgetConfig } from '../common/types.js'
import { evaluateNotifications, inQuietHours, type NotifyState } from '../common/notify-rules.js'

/** 사용량 갱신마다 알림 판정을 돌리고 Windows 알림을 띄운다. 보낸 기록은 파일에 남겨 앱을 다시 켜도 같은 주기에 반복하지 않는다. */
export class UsageNotifier {
  private state: NotifyState = {}
  private saveTimer: NodeJS.Timeout | undefined
  // 표시 중인 알림을 붙잡아 둔다. 참조가 없으면 가비지 수집되어 알림을 눌러도 click이 오지 않는다(Electron 알려진 문제).
  private readonly live = new Set<Notification>()

  constructor(private readonly file: string, private readonly icon: string | undefined, private readonly onClick: () => void) {
    try { if (fs.existsSync(file)) this.state = JSON.parse(fs.readFileSync(file, 'utf-8')) || {} }
    catch (err) { console.warn('[Notifier] 알림 기록을 읽지 못해 새로 시작합니다:', err) }
  }

  handle(usages: AccountUsage[], config: WidgetConfig) {
    const { events, state } = evaluateNotifications(usages, config, this.state)
    const changed = JSON.stringify(state) !== JSON.stringify(this.state)
    this.state = state
    if (changed) this.save()
    // 쉬는 시간에는 보내지 않는다(이미 지난 알림을 나중에 몰아 보내지도 않는다: 기록은 위에서 저장됨).
    if (inQuietHours(config.notifyQuiet)) return 0
    for (const e of events) this.show(e.title, e.body)
    return events.length
  }

  /** 사용량과 관계없는 안내(새 버전 준비 등). 알림을 꺼 두었어도 보낸다. */
  notice(title: string, body: string, onClick?: () => void) {
    if (!Notification.isSupported()) return false
    const n = new Notification({ title, body, icon: this.icon, silent: true })
    this.live.add(n)
    n.on('click', () => { this.live.delete(n); (onClick || this.onClick)() })
    n.on('close', () => this.live.delete(n))
    n.show()
    return true
  }

  /** 설정 창의 '테스트 알림 보내기'. 실제 판정과 같은 문장 형식으로 보낸다. */
  test() {
    return this.show('Claude Code 5시간 한도 18% 남음', '리셋까지 2시간 41분 · 지금 속도면 1시간 5분 뒤 소진 예상 (테스트 알림)')
  }

  private show(title: string, body: string) {
    if (!Notification.isSupported()) return false
    const n = new Notification({ title, body, icon: this.icon, silent: false })
    this.live.add(n)
    n.on('click', () => { this.live.delete(n); this.onClick() })
    n.on('close', () => this.live.delete(n))
    n.show()
    return true
  }

  private save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 500)
  }

  /** 미뤄 둔 저장을 바로 한다(앱 종료 때). */
  flush() {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf-8')
      fs.renameSync(tmp, this.file)
    } catch (err) { console.warn('[Notifier] 알림 기록을 저장하지 못했습니다:', err) }
  }
}
