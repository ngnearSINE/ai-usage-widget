/**
 * 명령 팔레트 검색. 입력한 낱말이 모두 들어 있는 명령만, 순서와 상관없이 찾는다(부분 낱말 가능).
 * 순위: 제목이 낱말로 시작 > 제목의 낱말 머리에 있음 > 제목 어딘가 > 별칭·분류에만 있음. 같으면 최근에 쓴 것, 그다음 원래 순서.
 * 아무것도 입력하지 않으면 최근에 쓴 것을 앞에 두고 나머지는 원래 순서.
 */
export interface Matchable { id: string; title: string; keywords?: string; group?: string }

const norm = (s: string) => s.toLowerCase().normalize('NFC')

export function rankCommands<T extends Matchable>(list: T[], query: string, recent: string[] = []): T[] {
  const tokens = norm(query).split(/\s+/).filter(Boolean)
  const recentRank = (id: string) => { const i = recent.indexOf(id); return i < 0 ? 0 : (recent.length - i) / recent.length }
  const scored: Array<{ c: T; i: number; s: number }> = []
  list.forEach((c, i) => {
    const title = norm(c.title), hay = `${title} ${norm(c.keywords || '')} ${norm(c.group || '')}`
    let s = 0
    for (const t of tokens) {
      if (!hay.includes(t)) return
      s += title.startsWith(t) ? 4 : new RegExp(`(^|[\\s·(/-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title) ? 3 : title.includes(t) ? 2 : 1
    }
    scored.push({ c, i, s: s + recentRank(c.id) * (tokens.length ? 0.5 : 10) })
  })
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.c)
}

/** 최근 사용 목록에 앞으로 넣는다(중복 없이, 최대 n개). */
export function pushRecent(recent: string[], id: string, n = 20): string[] {
  return [id, ...recent.filter(x => x !== id)].slice(0, n)
}
