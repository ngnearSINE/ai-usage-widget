import type { Rect } from './widget-layout.js'

/** CSS border-radius와 같은 영역을 OS 창에도 적용해 아크릴의 사각 모서리를 잘라낸다. */
export function roundedWindowShape(width: number, height: number, radius = 18): Rect[] {
  const w=Math.max(1,Math.round(width)),h=Math.max(1,Math.round(height))
  const r=Math.max(0,Math.min(Math.floor(radius),Math.floor(w/2),Math.floor(h/2)))
  if (!r) return [{x:0,y:0,width:w,height:h}]
  const rects:Rect[]=[]
  if(h>r*2) rects.push({x:0,y:r,width:w,height:h-r*2})
  for(let y=0;y<r;y++) {
    const dy=r-y-.5
    const inset=Math.ceil(r-Math.sqrt(Math.max(0,r*r-dy*dy)))
    rects.push({x:inset,y,width:w-inset*2,height:1})
    rects.push({x:inset,y:h-y-1,width:w-inset*2,height:1})
  }
  return rects
}
