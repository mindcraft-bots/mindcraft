import test from 'node:test'
import assert from 'node:assert/strict'

import { Ollama, selectResponseText } from '../src/models/ollama.js'

const open = '<think>'
const close = '</think>'

test('keeps the answer outside the reasoning trace', () => {
  assert.equal(selectResponseText(`${open}\nthinking out loud${close}\nHello there`), 'Hello there')
})

test('returns the reasoning content when the answer is inside the trace (#844)', () => {
  const content = `${open}\nHey there! I am brick, your Minecraft pal. What should we do first?${close}`
  assert.equal(selectResponseText(content), 'Hey there! I am brick, your Minecraft pal. What should we do first?')
})

test('joins several traces when nothing is left outside them', () => {
  assert.equal(selectResponseText(`${open}first${close}${open}second${close}`), 'first\nsecond')
})

test('uses message.thinking when the content is empty', () => {
  assert.equal(selectResponseText('', 'I should greet the player.'), 'I should greet the player.')
})

test('leaves a plain response untouched', () => {
  assert.equal(selectResponseText('Hello there'), 'Hello there')
})

test('sendRequest answers with the reasoning content instead of an empty reply', async () => {
  const ollama = new Ollama('test-model', 'http://127.0.0.1:1')
  ollama.send = async () => ({ message: { content: `${open}\nHello there${close}` } })
  const reply = await ollama.sendRequest([{ role: 'user', content: 'hi' }], 'system')
  assert.equal(reply, 'Hello there')
})

test('sendRequest falls back to message.thinking', async () => {
  const ollama = new Ollama('test-model', 'http://127.0.0.1:1')
  ollama.send = async () => ({ message: { content: '', thinking: 'I should greet the player.' } })
  const reply = await ollama.sendRequest([{ role: 'user', content: 'hi' }], 'system')
  assert.equal(reply, 'I should greet the player.')
})
