/**
 * 카드 위 마우스 빛. 테두리 중 마우스에 가까운 부분이 가늘게 밝아지고 안쪽에 아주 옅은 빛이 깔린다.
 * 빛은 마우스를 바로 따라붙지 않고 살짝 늦게 미끄러지듯 따라온다(프레임마다 남은 거리의 일부만 다가간다).
 * 켜지고 꺼지는 건 CSS(--glow 전환)가 맡는다. 움직임 '없음'·시스템 애니메이션 끄기면 CSS에서 꺼진다.
 */
const EASE = 0.16

export function initCardGlow(container: HTMLElement) {
  const pos = new Map<HTMLElement, { x: number; y: number; tx: number; ty: number }>()
  let frame = 0
  const tick = () => {
    frame = 0
    for (const [card, p] of pos) {
      if (!card.isConnected) { pos.delete(card); continue }
      p.x += (p.tx - p.x) * EASE; p.y += (p.ty - p.y) * EASE
      card.style.setProperty('--mx', `${p.x.toFixed(1)}px`); card.style.setProperty('--my', `${p.y.toFixed(1)}px`)
      if (Math.abs(p.tx - p.x) + Math.abs(p.ty - p.y) > 0.5) frame ||= requestAnimationFrame(tick)
    }
  }
  container.addEventListener('pointermove', e => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.ucard')
    if (!card || card.classList.contains('drag-ghost')) return
    const r = card.getBoundingClientRect(), tx = e.clientX - r.left, ty = e.clientY - r.top
    const p = pos.get(card)
    // 카드에 처음 들어올 때는 그 자리에서 시작한다(먼 곳에서 날아오지 않게).
    if (!p) pos.set(card, { x: tx, y: ty, tx, ty })
    else { p.tx = tx; p.ty = ty }
    frame ||= requestAnimationFrame(tick)
  })
}
