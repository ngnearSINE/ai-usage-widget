import test from 'node:test'
import assert from 'node:assert/strict'
import { surfaceKind, surfaceOpacity } from '../src/common/surface.js'

test('아크릴을 켜면 아크릴을 그릴 수 있는 창, 끄면 불투명도와 상관없이 투명 창을 쓴다', () => {
  assert.equal(surfaceKind({ useAcrylic: true, opacity: 40 }, true), 'backdrop')
  assert.equal(surfaceKind({ useAcrylic: false, opacity: 100 }, true), 'layered') // 불투명도로는 종류가 바뀌지 않는다
  assert.equal(surfaceKind({ useAcrylic: false, opacity: 99 }, true), 'layered')
  assert.equal(surfaceKind({}, true), 'backdrop')
  // 아크릴을 못 쓰는 Windows는 늘 투명 창으로 비친다.
  assert.equal(surfaceKind({ useAcrylic: true, opacity: 100 }, false), 'layered')
})

test('불투명도는 0~100 정수로 맞춘다', () => {
  assert.equal(surfaceOpacity({}), 70)
  assert.equal(surfaceOpacity({ opacity: 140 }), 100)
  assert.equal(surfaceOpacity({ opacity: -3 }), 0)
  assert.equal(surfaceOpacity({ opacity: 55.6 }), 56)
})
