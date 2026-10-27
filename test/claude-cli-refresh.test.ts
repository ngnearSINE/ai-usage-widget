import test from 'node:test'
import assert from 'node:assert/strict'
import { refreshDecision, REFRESH_GRACE_MS, RETRY_AFTER_FAIL_MS } from '../src/services/claude-cli-refresh.js'

const now = Date.UTC(2026, 9, 27, 12)
const base = { accessToken: 'a', refreshToken: 'r', expiresAt: now + 3600e3, refreshTokenExpiresAt: now + 20 * 86400e3 }

test('CLI 토큰 대신 갱신: 쓰는 중인 토큰은 건드리지 않고 만료 10분 뒤에만', () => {
  assert.equal(refreshDecision(base, now), 'fresh', '아직 유효')
  assert.equal(refreshDecision({ ...base, expiresAt: now - 60e3 }, now), 'wait', '만료 직후에는 CLI가 갱신할 시간을 둔다')
  assert.equal(refreshDecision({ ...base, expiresAt: now - REFRESH_GRACE_MS }, now), 'refresh')
  assert.equal(refreshDecision({ ...base, expiresAt: now - REFRESH_GRACE_MS }, now, now - 60e3), 'wait', '실패 뒤 1시간은 쉰다')
  assert.equal(refreshDecision({ ...base, expiresAt: now - REFRESH_GRACE_MS }, now, now - RETRY_AFTER_FAIL_MS), 'refresh')
  assert.equal(refreshDecision({ ...base, refreshTokenExpiresAt: now - 1 }, now), 'relogin', '갱신 토큰이 끝나면 다시 로그인')
  assert.equal(refreshDecision({ ...base, refreshToken: '' }, now), 'none')
  assert.equal(refreshDecision({ ...base, expiresAt: 0 }, now), 'none', '만료 시각이 없는 장기 토큰은 대상 아님')
  assert.equal(refreshDecision(undefined, now), 'none')
})
