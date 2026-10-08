import type { RenderPropsOf, TurnStepInput, TurnStepResult } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { parse, serialize, TEMPLATE } from '../hooks/handover'
import { classify, costOf } from '../hooks/shared'

const STEP: TurnStepInput = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }
const USAGE = {
  input_tokens: 10_000,
  output_tokens: 1_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}
const SUBMIT = { wait: false, origin: { kind: 'composer' } } as const
const PANE = {
  plugin: 'SecondBrainSystem',
  component: 'Pane',
  requestId: 'second-brain',
  // The props the pane hook reads; the rest of Pane's props it never touches.
  props: { title: 'Second Brain', isFocused: false, bodyColumns: 60, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
} as const

/** Runs one step through the chain and resolves to the generator's own return value. */
async function runStep($: { turn: { step: (e: TurnStepInput) => AsyncGenerator<unknown, TurnStepResult> } }) {
  const stream = $.turn.step(STEP)
  for (;;) {
    const step = await stream.next()
    if (step.done) return step.value
  }
}

const answered = (e: TurnStepInput) => ({
  turnId: e.turnId,
  index: e.index,
  answer: 'ok',
  toolUses: [],
  stopReason: 'end_turn' as const,
  usage: { ...USAGE, model: e.model },
})

describe('frugal router', () => {
  test('a light prompt is sent to Haiku and the saving is counted', async ($, on) => {
    mock.store(on)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    const sent: string[] = []
    on('turn.step', async function* (_$, e) {
      sent.push(e.model)
      return answered(e)
    })

    await $.prompt.submit({ ...SUBMIT, text: 'git status' })
    await runStep($)

    expect(sent).toEqual(['claude-haiku-5-5'])
    const saved = costOf(USAGE, 'claude-opus-5-5') - costOf(USAGE, 'claude-haiku-5-5')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: `$${saved.toFixed(4)}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(1 req)' })).toBeDefined()
    await ui.unmount()
  })

  test('a 429 from Haiku falls back to Sonnet without failing the step', async ($, on) => {
    mock.store(on)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    const sent: string[] = []
    on('turn.step', async function* (_$, e) {
      sent.push(e.model)
      if (e.model === 'claude-haiku-5-5') throw new Error('429 rate_limit_error')
      return answered(e)
    })

    await $.prompt.submit({ ...SUBMIT, text: 'add a comment to this function' })
    const result = await runStep($)

    expect(sent).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(result.answer).toBe('ok')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '1 fallbacks' })).toBeDefined()
    await ui.unmount()
  })

  test('an empty response from Haiku (request failed) also falls back', async ($, on) => {
    mock.store(on)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    const sent: string[] = []
    on('turn.step', async function* (_$, e) {
      sent.push(e.model)
      if (e.model === 'claude-haiku-5-5') {
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
      }
      return answered(e)
    })

    await $.prompt.submit({ ...SUBMIT, text: 'git log' })
    const result = await runStep($)

    expect(result.answer).toBe('ok')
    expect(sent).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
  })

  test('a deep coding prompt goes to the heavy model', async ($, on) => {
    mock.store(on)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    const sent: string[] = []
    on('turn.step', async function* (_$, e) {
      sent.push(e.model)
      return answered(e)
    })

    await $.prompt.submit({ ...SUBMIT, text: 'refactor the parser and fix the race condition' })
    await runStep($)

    expect(sent).toEqual(['claude-sonnet-5-5'])
  })
})

describe('dashboard', () => {
  test('draws its three sections on every surface that docks a pane', async $ => {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      for (const heading of ['Active Agents', 'Second Brain Monitor', 'Savings Meter']) {
        expect(await ui.find({ type: 'Text', text: heading })).toBeDefined()
      }
      await ui.unmount()
    }
  })
})

describe('classify', () => {
  test('sorts prompts into tiers', async () => {
    expect(classify('git status').tier).toBe('light')
    expect(classify('show me the README file').tier).toBe('light')
    expect(classify('fix typo in docs/setup.md').tier).toBe('heavy')
    expect(classify('implement OAuth login').tier).toBe('heavy')
    expect(classify('!light refactor this').tier).toBe('light')
  })
})

describe('handover.md', () => {
  test('round-trips tasks and keeps hand-written sections', async () => {
    const text = TEMPLATE.replace(
      '## Tasks\n',
      '## Tasks\n\n- [ ] write the parser\n- [x] (T7) ship v1 — @session-ab12: 3 files changed\n',
    ).replace('## Notes\n', '## Notes\nkeep me\n')
    const doc = parse(text)

    expect(doc.tasks.map(t => [t.id, t.state, t.text, t.owner, t.note])).toEqual([
      ['T8', 'open', 'write the parser', undefined, undefined],
      ['T7', 'done', 'ship v1', 'session-ab12', '3 files changed'],
    ])
    const again = parse(serialize(doc))
    expect(again.tasks).toEqual(doc.tasks)
    expect(serialize(doc)).toContain('keep me')
  })
})
