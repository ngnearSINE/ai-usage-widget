import test from 'node:test'
import assert from 'node:assert/strict'
import { appMatches } from '../src/main/service-launch.js'

test('카드의 앱 열기: 진짜 데스크톱 앱만 고르고 브라우저 웹앱(PWA)은 뺀다', () => {
  assert.ok(appMatches('claude', 'Claude', 'Claude_pzs8sxrjxfjjc!Claude'))
  assert.ok(!appMatches('claude', 'Claude', 'Chrome._crx_fmpnlaolkdacoja.UserData.Profile1'))
  assert.ok(appMatches('codex', 'ChatGPT', 'OpenAI.Codex_2p2nqsd0c76g0!App'))
  assert.ok(!appMatches('codex', 'ChatGPT Classic', 'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT'))
  assert.ok(appMatches('xai', 'Grok Bot', 'electron.app.Grok Bot'))
  assert.ok(!appMatches('xai', 'Grok', 'Chrome._crx_ggjoclfcnjemagj.UserData.Profile1'))
  assert.ok(appMatches('claude', 'Claude', 'claude-desktop'), 'Linux .desktop')
  assert.ok(!appMatches('antigravity', 'Claude', 'x'))
})
