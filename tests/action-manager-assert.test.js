import test from 'node:test'
import assert from 'node:assert/strict'

import { ActionManager } from '../src/agent/action_manager.js'

const fakeAgent = () => ({
  bot: { interrupt_code: false, output: '', emit: () => {} },
  history: { add: () => {} },
  clearBotLogs: () => {},
  requestInterrupt: () => {},
  isIdle: () => true,
  self_prompter: { isActive: () => false },
  cleanKill: () => {},
})

test('starting a resume without a label fails with an assertion error, not a ReferenceError', async () => {
  const manager = new ActionManager(fakeAgent())
  await assert.rejects(
    () => manager.runAction(null, async () => {}, { resume: true }),
    (err) => {
      assert.equal(err.code, 'ERR_ASSERTION')
      assert.match(err.message, /actionLabel is required for new resume/)
      return true
    }
  )
})
