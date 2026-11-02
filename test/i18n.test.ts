import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EN, EN_PARTS } from '../src/common/locales/en.js'
import { detectLang, resolveLang, setLang, tr, msg, trText } from '../src/common/i18n.js'
import { scan, varsOf } from './i18n-scan.js'

// 컴파일된 테스트(.test-build/test)에서 원본 src로
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')

test('언어 판별: 첫 시스템 언어가 한국어일 때만 한국어', () => {
  assert.equal(detectLang('ko-KR'), 'ko')
  assert.equal(detectLang(['en-US', 'ko-KR']), 'en')
  assert.equal(detectLang(['ko', 'en-US']), 'ko')
  assert.equal(detectLang('ja-JP'), 'en')
  assert.equal(detectLang(undefined), 'en')
  assert.equal(resolveLang('system', ['de-DE']), 'en')
  assert.equal(resolveLang('ko', ['de-DE']), 'ko')
  assert.equal(resolveLang('en', 'ko-KR'), 'en')
})

test('tr·msg·trText: 바로 옮기기와 나중에 옮기기', () => {
  const ko = Object.keys(EN).find(k => /\{\w+\}/.test(k))
  setLang('en')
  try {
    assert.equal(tr('사전에 없는 문구'), '사전에 없는 문구')
    if (ko) {
      const vars = Object.fromEntries(varsOf(ko).split(',').map((k, i) => [k, `V${i}`]))
      assert.equal(trText(msg(ko, vars)), tr(ko, vars))
    }
  } finally { setLang('ko') }
  assert.equal(tr('사전에 없는 문구'), '사전에 없는 문구')
})

test('감싼 한국어 문구는 모두 영어 번역이 있고 {변수}가 같다', () => {
  const { keys, dynamic } = scan(SRC)
  const missing = [...new Map(keys.filter(k => EN[k.text] === undefined).map(k => [k.text, k])).values()]
  assert.deepEqual(missing.map(k => `${k.file}:${k.line} ${k.text}`), [], '영어 번역이 없는 문구')
  const badVars = Object.entries(EN).filter(([ko, en]) => varsOf(ko) !== varsOf(en)).map(([ko]) => ko)
  assert.deepEqual(badVars, [], '{변수}가 다른 번역')
  assert.deepEqual(dynamic.map(d => `${d.file}:${d.line} ${d.text}`), [], 'tr()·msg()의 첫 인자는 고정 문자열이어야 한다')
})

test('감싸지 않은 한국어 문구가 없다(남길 것은 // i18n-ok)', () => {
  const { leftovers } = scan(SRC)
  assert.deepEqual(leftovers.map(d => `${d.file}:${d.line} ${d.text}`), [])
})

test('같은 원문을 영역마다 다르게 번역하지 않는다', () => {
  const seen = new Map<string, [string, string]>()
  const conflicts: string[] = []
  for (const [part, dict] of Object.entries(EN_PARTS)) for (const [ko, en] of Object.entries(dict)) {
    const prev = seen.get(ko)
    if (prev && prev[1] !== en) conflicts.push(`${ko}: ${prev[0]}="${prev[1]}" / ${part}="${en}"`)
    else seen.set(ko, [part, en])
  }
  assert.deepEqual(conflicts, [])
})
