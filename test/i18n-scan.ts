import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * 소스에서 한국어 문구를 찾는다.
 * - keys: tr()·msg()의 첫 인자(번역 열쇠)
 * - leftovers: 감싸지 않은 한국어 문자열(주석·번역 사전·'// i18n-ok' 줄은 뺀다)
 * - dynamic: tr()·msg()의 첫 인자가 고정 문자열이 아닌 곳(열쇠를 알 수 없음)
 */
export interface ScanHit { file: string; line: number; text: string }
export interface ScanResult { keys: ScanHit[]; leftovers: ScanHit[]; dynamic: ScanHit[] }

const HANGUL = /[가-힣]/
const WRAPPERS = new Set(['tr', 'msg'])

export function listSources(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'locales') walk(p) }
      else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

export function scanFile(file: string, label = file): ScanResult {
  const text = fs.readFileSync(file, 'utf8')
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const lines = text.split(/\r?\n/)
  const res: ScanResult = { keys: [], leftovers: [], dynamic: [] }
  const lineOf = (n: ts.Node) => src.getLineAndCharacterOfPosition(n.getStart(src)).line
  const okLine = (n: ts.Node) => {
    const a = lineOf(n), b = src.getLineAndCharacterOfPosition(n.getEnd()).line
    for (let i = a; i <= b; i++) if (lines[i]?.includes('i18n-ok')) return true
    return false
  }
  const hit = (n: ts.Node, t: string): ScanHit => ({ file: label, line: lineOf(n) + 1, text: t })
  const isWrapperArg = (n: ts.Node) => {
    const p = n.parent
    return !!p && ts.isCallExpression(p) && p.arguments[0] === n && ts.isIdentifier(p.expression) && WRAPPERS.has(p.expression.text)
  }
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && WRAPPERS.has(n.expression.text) && n.arguments.length) {
      const a = n.arguments[0]
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) res.keys.push(hit(a, a.text))
      else if (!okLine(n)) res.dynamic.push(hit(a, a.getText(src)))
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (HANGUL.test(n.text) && !isWrapperArg(n) && !okLine(n)) res.leftovers.push(hit(n, n.text))
    } else if (ts.isTemplateExpression(n)) {
      const parts = [n.head.text, ...n.templateSpans.map(s => s.literal.text)]
      if (parts.some(p => HANGUL.test(p)) && !okLine(n)) res.leftovers.push(hit(n, parts.join('${…}')))
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return res
}

export function scan(root: string): ScanResult {
  const all: ScanResult = { keys: [], leftovers: [], dynamic: [] }
  for (const f of listSources(root)) {
    const r = scanFile(f, path.relative(root, f).replace(/\\/g, '/'))
    all.keys.push(...r.keys); all.leftovers.push(...r.leftovers); all.dynamic.push(...r.dynamic)
  }
  return all
}

/** 원문과 번역의 {변수} 모음이 같은지. */
export const varsOf = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort().join(',')
