import test from 'node:test'
import assert from 'node:assert/strict'
import { cardLayout, fitWindow, isDockTarget, moveAccountBefore, retainedUsage, visibleUsages, minWindowHeight, snapToEdges } from '../src/common/widget-layout.js'
import { previewUsages } from '../src/common/preview-data.js'
import type { AccountConfig, WidgetConfig } from '../src/common/types.js'
import { roundedWindowShape } from '../src/common/window-shape.js'

test('모니터가 분리되거나 저장 좌표가 잘못되어도 창 전체를 작업 영역 안으로 복원한다', () => {
  const area={x:-1920,y:0,width:1920,height:1040}
  assert.deepEqual(fitWindow({x:4000,y:-900,width:800,height:600},area),{x:-800,y:0,width:800,height:600})
  assert.deepEqual(fitWindow({x:NaN,y:NaN,width:NaN,height:NaN},{x:0,y:0,width:250,height:180}),{x:0,y:0,width:250,height:180})
})
test('보조 모니터 하단과 자동 숨김 작업표시줄을 감지하고 상단·측면은 오인하지 않는다', () => {
  const bounds={x:1920,y:-200,width:1920,height:1080}
  assert.equal(isDockTarget({x:2000,y:830},bounds,{...bounds,height:1032}),true)
  assert.equal(isDockTarget({x:2000,y:500},bounds,{...bounds,height:1032}),false)
  assert.equal(isDockTarget({x:1800,y:870},bounds,bounds),false)
  assert.equal(isDockTarget({x:2000,y:875},bounds,bounds),true)
  assert.equal(isDockTarget({x:2000,y:875},bounds,{...bounds,y:-152,height:1032}),false)
})
test('자동 숨김은 미연결만 제외하고 마지막 실측값·순서·수동 숨김을 유지한다', () => {
  const usages=previewUsages().slice(0,3)
  usages[0].status='error'; usages[1].status='stale'
  const accounts:AccountConfig[]=usages.map(u=>({id:u.id,name:u.name,provider:u.provider,enabled:true}))
  accounts[2].hidden=true
  assert.deepEqual(visibleUsages(usages,accounts,{hideDisconnected:true} as WidgetConfig).map(u=>u.id),[usages[1].id])
  assert.equal(visibleUsages(usages,accounts,{hideDisconnected:false} as WidgetConfig).length,2)
})
test('카드를 앞이나 끝으로 옮겨도 비활성·숨긴 계정과 원본 배열을 보존한다', () => {
  const accounts:AccountConfig[]=['a','b','c'].map(id=>({id,name:id,provider:'custom',enabled:id!=='b',hidden:id==='b'}))
  assert.deepEqual(moveAccountBefore(accounts,'c','a').map(a=>a.id),['c','a','b'])
  assert.deepEqual(moveAccountBefore(accounts,'a',null).map(a=>a.id),['b','c','a'])
  assert.deepEqual(accounts.map(a=>a.id),['a','b','c'])
  assert.equal(moveAccountBefore(accounts,'a','missing'),accounts)
})
test('일시 실패는 실측 시각·수치를 유지하고 첫 연결 실패는 정상값으로 바꾸지 않는다', () => {
  const previous=previewUsages()[2]
  const failed={...previous,status:'error' as const,updatedAt:new Date(Date.now()+60000).toISOString(),errorMessage:'조회 실패'}
  const stale=retainedUsage(failed,previous)
  assert.equal(stale.status,'stale'); assert.equal(stale.updatedAt,previous.updatedAt)
  assert.equal(stale.primaryQuota,previous.primaryQuota); assert.equal(stale.errorMessage,'조회 실패')
  assert.equal(previous.status,'ready'); assert.equal(retainedUsage(failed).status,'error')
})

test('종횡비와 서비스 수에 맞춰 정보 밀도를 바꾸고 모든 카드를 스크롤 없이 배치한다', () => {
  const cases=[{w:580,h:430,n:3,d:'rich'},{w:560,h:300,n:3,d:'medium'},{w:270,h:200,n:3,d:'compact'},{w:270,h:110,n:3,d:'minimal'}]
  for(const {w,h,n,d} of cases) {
    const layout=cardLayout(w,h,n,8)
    assert.equal(layout.density,d)
    assert.ok(layout.rows*layout.columns>=n)
    assert.equal(layout.capacity,n)
  }
  const many=cardLayout(270,110,30,8)
  assert.equal(many.density,'minimal')
  assert.ok(many.capacity<30 && many.capacity>0)
})

test('아크릴의 실제 창 영역은 모서리를 제외하고 크기 변경 뒤에도 본문을 포함한다',()=>{
  for(const [w,h] of [[300,220],[640,680],[716,293]]) {
    const rects=roundedWindowShape(w,h)
    const includes=(x:number,y:number)=>rects.some(r=>x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height)
    for(const [x,y] of [[0,0],[w-1,0],[0,h-1],[w-1,h-1]]) assert.equal(includes(x,y),false)
    for(const [x,y] of [[w/2,0],[w/2,h-1],[0,h/2],[w-1,h/2],[w/2,h/2]]) assert.equal(includes(x,y),true)
  }
})

test('최소 창 높이는 보이는 카드가 모두 들어가는 높이다(서비스 하나면 카드 한 장)', () => {
  assert.equal(minWindowHeight(172, 1), 68)
  // 좁으면 한 줄에 하나씩: 카드 3장 = 56×3 + 간격 6×2 + 여백 12, 제목줄 숨김 기준(너비 300) 미만이라 제목줄 없음
  assert.equal(minWindowHeight(172, 3), 192)
  // 넓으면 두 장씩: 2줄 = 56×2 + 6 + 12, 너비 300 이상이고 높이가 110 이상이 되면 제목줄(36)을 더한다
  assert.equal(minWindowHeight(340, 3), 166)
  // 한 줄에 다 들어가면 제목줄 없이도 110 미만이라 제목줄을 빼고 잰다
  assert.equal(minWindowHeight(600, 3), 68)
})

test('설정 변경은 아는 키와 올바른 형식만 받는다', async () => {
  const { sanitizeConfigPatch } = await import('../src/common/config-schema.js')
  assert.deepEqual(sanitizeConfigPatch({ opacity: 140, design: 'bars', evil: 1, useAcrylic: 'yes', cardGap: 7.4 }), { opacity: 100, design: 'bars', cardGap: 7 })
  assert.deepEqual(sanitizeConfigPatch({ windowBounds: { x: 1, y: 2, width: 'a', height: 4 } }), {})
  assert.deepEqual(sanitizeConfigPatch({ shortcuts: { toggle: 'Ctrl+Alt+U', lock: 5 } }), { shortcuts: { toggle: 'Ctrl+Alt+U' } })
  assert.deepEqual(sanitizeConfigPatch(null), {})
  // 배경 색: #rrggbb만 받고, ''(고르지 않음)은 지운다
  assert.deepEqual(sanitizeConfigPatch({ backgroundColor: '#1B1D27' }), { backgroundColor: '#1B1D27' })
  assert.deepEqual(sanitizeConfigPatch({ backgroundColor: '' }), { backgroundColor: undefined })
  assert.deepEqual(sanitizeConfigPatch({ backgroundColor: 'red' }), {})
})

test('어림값으로 바뀌면 마지막 실측을 갱신 지연으로 유지한다', () => {
  const real = { ...previewUsages()[0], status: 'ready' as const }
  const est = { ...real, isEstimated: true, primaryQuota: { ...real.primaryQuota, percentLeft: 95 } }
  const kept = retainedUsage(est, real)
  assert.equal(kept.status, 'stale')
  assert.equal(kept.primaryQuota.percentLeft, real.primaryQuota.percentLeft)
  assert.equal(retainedUsage(est, undefined), est, '실측이 없으면 어림값이라도 보여 준다')
})

test('카드 위치 고정은 참·거짓만 받는다', async () => {
  const { sanitizeConfigPatch } = await import('../src/common/config-schema.js')
  assert.deepEqual(sanitizeConfigPatch({ lockCards: true }), { lockCards: true })
  assert.deepEqual(sanitizeConfigPatch({ lockCards: 'yes' }), {})
})

test('제목줄을 항상 숨기면 최소 높이에서 제목줄을 뺀다', () => {
  assert.equal(minWindowHeight(340, 3), 166)
  assert.equal(minWindowHeight(340, 3, 6, true), 130)
})

test('화면 가장자리 자석: 가로·세로를 따로, 같은 쪽 경계로 잰다', () => {
  // 모니터 1920×1080, 작업 표시줄 48px(작업 영역 높이 1032)
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 }, area = { x: 0, y: 0, width: 1920, height: 1032 }
  const win = (x: number, y: number) => ({ x, y, width: 400, height: 300 })
  assert.deepEqual(snapToEdges(win(500, 500), area, bounds), { x: 500, y: 500 }, '멀면 그대로')
  assert.deepEqual(snapToEdges(win(10, 500), area, bounds), { x: 0, y: 500 }, '왼쪽 12px 안')
  assert.deepEqual(snapToEdges(win(-9, 500), area, bounds), { x: 0, y: 500 }, '밖으로 조금 나가도 붙음')
  assert.deepEqual(snapToEdges(win(13, 500), area, bounds), { x: 13, y: 500 }, '12px 넘으면 그대로')
  assert.deepEqual(snapToEdges(win(1515, 8), area, bounds), { x: 1520, y: 0 }, '오른쪽 위 모서리')
  assert.deepEqual(snapToEdges(win(500, 740), area, bounds), { x: 500, y: 732 }, '아래는 작업 표시줄 바로 위(창 아래쪽 경계로 잼)')
  assert.deepEqual(snapToEdges(win(500, 745), area, bounds), { x: 500, y: 745 }, '더 내리면 떨어짐(독 판정은 그대로)')
})

test('화면 가장자리 자석: 다른 모니터와 맞닿은 경계에는 붙지 않는다', () => {
  const left = { x: 0, y: 0, width: 1920, height: 1080 }, right = { x: 1920, y: 300, width: 2560, height: 1440 }
  const area = { x: 0, y: 0, width: 1920, height: 1032 }
  assert.deepEqual(snapToEdges({ x: 1515, y: 500, width: 400, height: 300 }, area, left, [right]), { x: 1515, y: 500 }, '오른쪽은 안쪽 경계')
  assert.deepEqual(snapToEdges({ x: 1515, y: 500, width: 400, height: 300 }, area, left, []), { x: 1520, y: 500 }, '모니터 하나면 붙음')
  assert.deepEqual(snapToEdges({ x: 1515, y: 6, width: 400, height: 250 }, area, left, [right]), { x: 1520, y: 0 }, '옆 모니터가 낮게 붙어 있으면 오른쪽 위 구석은 바깥 경계라 붙음')
})
