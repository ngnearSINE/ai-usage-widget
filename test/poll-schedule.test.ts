import test from 'node:test'
import assert from 'node:assert/strict'
import { nextPollDelay } from '../src/common/poll-schedule.js'

test('적응형 조회: 쓰는 중이면 정한 간격, 안 쓰면 4배(15분까지)', () => {
  const now = 1_000_000
  assert.equal(nextPollDelay(120e3, false, [], now), 120e3)
  assert.equal(nextPollDelay(120e3, true, [], now), 480e3)
  assert.equal(nextPollDelay(300e3, true, [], now), 15 * 60e3, '4배가 15분을 넘으면 15분')
  assert.equal(nextPollDelay(30 * 60e3, true, [], now), 30 * 60e3, '정한 간격이 더 길면 그 간격')
})

test('적응형 조회: 다음 조회보다 먼저 리셋되면 리셋 20초 뒤에 묻는다', () => {
  const now = 1_000_000
  assert.equal(nextPollDelay(300e3, false, [now + 60e3], now), 80e3)
  assert.equal(nextPollDelay(300e3, false, [now + 400e3], now), 300e3, '리셋이 더 나중이면 그대로')
  assert.equal(nextPollDelay(300e3, false, [now - 5e3, NaN], now), 300e3, '지난 리셋·모르는 시각은 무시')
  assert.equal(nextPollDelay(300e3, false, [now + 1e3], now), 21e3)
})
