import test from 'node:test'
import assert from 'node:assert/strict'
import { inNightlyWindow, msUntilNightly } from '../src/main/updater-time.js'

test('새벽 3시 자동 설치: 다음 3시까지 남은 시간과 설치 시간대', () => {
  assert.equal(msUntilNightly(new Date(2026, 9, 27, 2, 0)), 3600e3)
  assert.equal(msUntilNightly(new Date(2026, 9, 27, 3, 0)), 24 * 3600e3, '정각이면 다음 날')
  assert.equal(msUntilNightly(new Date(2026, 9, 27, 23, 30)), 3.5 * 3600e3)
  assert.ok(inNightlyWindow(new Date(2026, 9, 27, 3, 0)))
  assert.ok(inNightlyWindow(new Date(2026, 9, 27, 4, 59)))
  assert.ok(!inNightlyWindow(new Date(2026, 9, 27, 5, 0)), '5시가 넘으면 사용 중일 수 있어 미룸')
  assert.ok(!inNightlyWindow(new Date(2026, 9, 27, 2, 59)))
})
