import test from 'node:test'
import assert from 'node:assert/strict'
import { displayUsage } from '../src/common/widget-layout.js'
import type { AccountUsage } from '../src/common/types.js'

test('앱을 켜자마자 기억해 둔 마지막 값을 확인 중으로 보여 주고, 받는 대로 바꾼다', () => {
  const quota = { remainingFraction: .4, percentLeft: 40, percentUsed: 60, resetCountdown: '1h', isExhausted: false }
  const last = { id: 'a', name: 'A', status: 'stale', primaryQuota: quota } as AccountUsage
  const initial = { id: 'a', name: 'A', status: 'loading' } as AccountUsage
  const start = displayUsage(undefined, last, initial)
  assert.equal(start.status, 'stale'); assert.equal(start.pending, true); assert.equal(start.everConnected, true); assert.equal(start.primaryQuota.percentLeft, 40)
  const fresh = displayUsage({ ...last, status: 'ready', pending: false }, last, initial)
  assert.equal(fresh.status, 'ready'); assert.equal(fresh.pending, false); assert.equal(fresh.everConnected, true)
  const never = displayUsage(undefined, undefined, initial)
  assert.equal(never.status, 'loading'); assert.notEqual(never.pending, true); assert.notEqual(never.everConnected, true)
})
