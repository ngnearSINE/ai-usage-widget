/** 상태 갱신 시 카드·포커스·스크롤·CSS 전환을 유지하는 작은 DOM 조정기. */
function key(node: Node): string | null {
  if (!(node instanceof Element)) return null
  for (const attr of ['data-card','data-drag','data-panel','data-action','data-range','data-toggle','data-enabled','data-hide']) {
    if (node.hasAttribute(attr)) return `${node.tagName}:${attr}:${node.getAttribute(attr)}`
  }
  return null
}
function sync(old: Node, next: Node): Node {
  if (old.nodeType !== next.nodeType || old.nodeName !== next.nodeName || (key(old) !== key(next))) {
    old.parentNode!.replaceChild(next,old); return next
  }
  if (!(old instanceof Element) || !(next instanceof Element)) {
    if (old.textContent !== next.textContent) old.textContent = next.textContent
    return old
  }
  for (const attr of Array.from(old.attributes)) if (!next.hasAttribute(attr.name)) old.removeAttribute(attr.name)
  for (const attr of Array.from(next.attributes)) if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name,attr.value)
  if (old instanceof HTMLInputElement && next instanceof HTMLInputElement) {
    if (old !== document.activeElement) old.value = next.value
    old.checked = next.checked
  }
  let cursor: ChildNode | null = old.firstChild
  for (const child of Array.from(next.childNodes)) {
    const childKey = key(child)
    if (childKey && key(cursor as Node) !== childKey) {
      const match = Array.from(old.childNodes).find(n => key(n) === childKey)
      if (match) { old.insertBefore(match,cursor); cursor=match }
    }
    if (!cursor) { old.appendChild(child); continue }
    const result = sync(cursor,child)
    cursor = result.nextSibling
  }
  while (cursor) { const after=cursor.nextSibling; old.removeChild(cursor); cursor=after }
  return old
}
export function updateMarkup(container: HTMLElement, html: string) {
  const template = document.createElement('template')
  template.innerHTML=html.trim()
  const next=template.content.firstChild!
  if (container.firstChild) sync(container.firstChild,next)
  else container.appendChild(next)
  while (container.childNodes.length>1) container.lastChild!.remove()
}
