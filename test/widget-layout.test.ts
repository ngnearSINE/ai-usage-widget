import test from 'node:test'
import assert from 'node:assert/strict'
import { cardLayout, fitWindow, isDockTarget, moveAccountBefore, retainedUsage, visibleUsages } from '../src/common/widget-layout.js'
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
  const usages=previewUsages()
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
