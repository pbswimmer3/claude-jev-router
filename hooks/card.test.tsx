import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'jev-router',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const HAIKU = JSON.stringify({
  model: 'jev-1.13.0',
  answers: {
    model: { type: 'choice', choice: 'haiku', confidence: 0.97, probabilities: { haiku: 0.97, sonnet: 0.03 } },
    effort: { type: 'choice', choice: 'low', confidence: 0.8, probabilities: { low: 0.8, medium: 0.2 } },
    alters_sensitive_state: { type: 'noul', noul: 0.02 },
    names_own_model: { type: 'noul', noul: 0.01 },
    continues_earlier_work: { type: 'noul', noul: 0.05 },
  },
})

// The desktop app hosts the session over the SDK, so that is the origin it stamps.
const SENT = { text: 'hi', wait: false, origin: { kind: 'sdk' } } as const

// Stands for the engine and Merge Gateway beneath the mod: a session on `model`, with `earlier` said.
function newSession(on: On, model: string, earlier: SessionMessage[] = []) {
  mock.env(on, { MERGE_GATEWAY_KEY: 'test-key' })
  mock.store(on)
  mock.clock(on)
  on('session.model', () => ({ value: model }))
  on('session.messages', () => ({ value: earlier }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: HAIKU } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

test("a new session's first message is routed as it is sent, on every surface", async ($, on) => {
  newSession(on, 'claude-opus-5-5')
  await $.prompt.submit(SENT)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Haiku 5\.5 · Low effort/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /running on Opus 5\.5/ }))?.text).toBeDefined()
    await ui.unmount()
  }
})

test('the card says so when the first message is on the suggested model already', async ($, on) => {
  newSession(on, 'claude-haiku-5-5')
  await $.prompt.submit(SENT)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /on Haiku 5\.5 already/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('later messages are left to the button', async ($, on) => {
  newSession(on, 'claude-opus-5-5', [{ role: 'user', text: 'earlier ask' } as SessionMessage])
  await $.prompt.submit(SENT)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: false } })
  expect((await ui.find({ type: 'Button', key: 'route' }))?.text).toBe('Route with Jev')
  await ui.unmount()
})
