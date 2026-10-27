import test from 'node:test'
import assert from 'node:assert/strict'
import { barColor, heatOf, ownColor } from '../src/common/bar-color.js'

const o = { on: true, warn: 20, crit: 10 }

test('한 번에: 기준 아래에서만 경고색', () => {
  assert.equal(barColor(60, '#111111', o), '#111111')
  assert.equal(barColor(21, '#111111', o), '#111111')
  assert.equal(barColor(20, '#111111', o), 'var(--warn)')
  assert.equal(barColor(10, '#111111', o), 'var(--danger)')
  assert.equal(barColor(5, '#111111', { ...o, on: false }), '#111111', '경고색을 끄면 늘 평소 색')
})

test('부드럽게: 50% 이상 평소 색, 그 아래로 주황·빨강으로 섞인다', () => {
  const s = { ...o, mode: 'smooth' as const }
  assert.equal(barColor(80, '#111111', s), '#111111')
  assert.equal(barColor(50, '#111111', s), '#111111')
  assert.equal(barColor(35, '#111111', s), 'color-mix(in oklab, var(--warn) 50%, #111111)')
  assert.equal(barColor(20, '#111111', s), 'var(--warn)')
  assert.equal(barColor(15, '#111111', s), 'color-mix(in oklab, var(--danger) 50%, var(--warn))')
  assert.equal(barColor(10, '#111111', s), 'var(--danger)')
  // 주의 기준이 50%보다 높아도 깨지지 않는다
  assert.equal(barColor(65, '#111111', { ...s, warn: 60 }), '#111111')
  assert.equal(barColor(60, '#111111', { ...s, warn: 60 }), 'var(--warn)')
})

test('평소 색 설정은 막대 색 스타일이 덮지 않도록 var(--own)으로 감싼다', () => {
  assert.equal(ownColor(undefined), undefined)
  assert.equal(ownColor('brand'), undefined)
  assert.equal(ownColor('green'), 'var(--own,var(--good))')
  assert.equal(ownColor('#12ab34'), 'var(--own,#12ab34)')
  assert.equal(ownColor('red;background:url(x)'), undefined)
})

test('경고 배경 세기: 여유 50% 이상은 0, 위험 기준에서 1, 그 사이는 연속', () => {
  assert.equal(heatOf(80, 20, 10), 0)
  assert.equal(heatOf(50, 20, 10), 0)
  assert.equal(heatOf(10, 20, 10), 1)
  assert.equal(heatOf(0, 20, 10), 1)
  const a = heatOf(40, 20, 10), b = heatOf(25, 20, 10)
  assert.ok(a > 0 && a < b && b < 1, '남은 양이 줄수록 진해진다')
  assert.equal(heatOf(80, 20, 10, true), 0.18, '속도 주의면 여유가 있어도 살짝')
})
