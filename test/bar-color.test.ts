import test from 'node:test'
import assert from 'node:assert/strict'
import { barColor, heatOf, ownColor, gradientColor, normalizeStops, DEFAULT_BAR_STOPS } from '../src/common/bar-color.js'

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

test('색 점 그라데이션: 기본은 50%까지 평소 색, 20% 주황, 10% 아래 빨강, 사이는 섞인다', () => {
  assert.equal(gradientColor(80, '#123456'), '#123456')
  assert.equal(gradientColor(50, '#123456'), '#123456')
  assert.equal(gradientColor(20, '#123456'), 'var(--warn)')
  assert.equal(gradientColor(5, '#123456'), 'var(--danger)')
  assert.equal(gradientColor(35, '#123456'), 'color-mix(in oklab, var(--warn) 50%, #123456)')
  assert.equal(barColor(35, '#123456', { on: true, warn: 20, crit: 10, stops: [] }), gradientColor(35, '#123456'))
  assert.equal(barColor(5, '#123456', { on: false, warn: 20, crit: 10, stops: DEFAULT_BAR_STOPS }), '#123456')
})

test('색 점 정리: 순서가 섞여도 남은 양이 큰 쪽부터, 범위 밖은 0~100으로, 2개 미만이면 기본', () => {
  assert.deepEqual(normalizeStops([{ at: 10, color: '#ff0000' }, { at: 120, color: 'brand' }]).map(s => s.at), [100, 10])
  assert.deepEqual(normalizeStops([{ at: 30, color: 'warn' }]), DEFAULT_BAR_STOPS)
  // 직접 고른 색과 양 끝 바깥
  const s = [{ at: 70, color: '#00ff00' }, { at: 30, color: '#0000ff' }]
  assert.equal(gradientColor(90, 'x', s), '#00ff00')
  assert.equal(gradientColor(0, 'x', s), '#0000ff')
  assert.equal(gradientColor(50, 'x', s), 'color-mix(in oklab, #0000ff 50%, #00ff00)')
})

test('색 점 한 번에 바뀌기: 남은 양이 점 위치에 닿는 순간 그 색, 사이는 섞지 않는다', () => {
  assert.equal(gradientColor(30, '#123456', undefined, 'step'), '#123456')
  assert.equal(gradientColor(20, '#123456', undefined, 'step'), 'var(--warn)')
  assert.equal(gradientColor(15, '#123456', undefined, 'step'), 'var(--warn)')
  assert.equal(gradientColor(10, '#123456', undefined, 'step'), 'var(--danger)')
  assert.equal(barColor(15, '#123456', { on: true, mode: 'step', warn: 20, crit: 10, stops: [] }), 'var(--warn)')
})
