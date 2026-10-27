/**
 * 마우스 설명. data-tip이 있는 요소 위에 올리면 메인 프로세스의 별도 설명 창에 띄운다.
 * 작은 위젯 창 안에 그리면 잘리므로 창 밖까지 나오는 창을 쓴다. 가장 안쪽 요소(눈금 > 막대 > 카드)가 이긴다.
 */
let current: HTMLElement | null = null
let timer: number | undefined

function hide() {
  clearTimeout(timer)
  if (current) window.api?.hideTip?.()
  current = null
}

export function initTooltips() {
  document.addEventListener('pointerover', e => {
    // 카드를 끌어 순서를 바꾸는 동안에는 설명을 띄우지 않는다.
    const el = document.body.classList.contains('reordering') ? null : (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-tip]') || null
    if (el === current) return
    const wasShowing = !!current
    current = el
    clearTimeout(timer)
    if (!el || !el.dataset.tip) { window.api?.hideTip?.(); current = null; return }
    // 처음 뜰 때만 잠깐 기다려 스쳐 지나가는 마우스에 깜빡이지 않게 하고, 이미 떠 있으면 바로 바꾼다.
    timer = window.setTimeout(() => {
      if (current !== el || !el.isConnected) return
      const r = el.getBoundingClientRect()
      window.api?.showTip?.(el.dataset.tip!, { x: r.left, y: r.top, width: r.width, height: r.height })
    }, wasShowing ? 0 : 140)
  })
  document.documentElement.addEventListener('pointerleave', hide)
  // 끌기·클릭·휠·창 전환 중에는 설명이 방해되므로 닫는다.
  window.addEventListener('pointerdown', hide, true)
  window.addEventListener('wheel', hide, { passive: true })
  window.addEventListener('blur', hide)
}
