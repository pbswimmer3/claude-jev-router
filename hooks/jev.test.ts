import { describe, expect, test } from 'claude-code/testing'

import { buildJevRequest, buildState, keyFromEnvFile, parseJevResponse, scrub } from './jev'

const config = { apiKey: 'test-key', endpoint: 'https://api-gateway.merge.dev/v1/decisions', model: 'typesafe/jev-1.13' }

describe('buildJevRequest', () => {
  test('posts all four questions to System One', async () => {
    const { url, init } = buildJevRequest(config, buildState('fix the flaky checkout test', []))
    const body = JSON.parse(init.body)

    expect(url).toBe('https://api-gateway.merge.dev/v1/decisions')
    expect(init.headers.authorization).toBe('Bearer test-key')
    expect(body.model).toBe('typesafe/jev-1.13')
    expect(typeof body.questions.model.criteria.opus).toBe('string')
    expect(Object.keys(body.questions)).toEqual(['model', 'effort', 'alters_sensitive_state', 'names_own_model'])
    expect(Object.keys(body.questions.model.criteria)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
  })

  test('adds the context gate only when asked', async () => {
    const state = buildState('hi', [])
    expect(JSON.parse(buildJevRequest(config, state, true).init.body).questions.continues_earlier_work.type).toBe('noul')
    expect(JSON.parse(buildJevRequest(config, state).init.body).questions.continues_earlier_work).toBeUndefined()
  })
})

describe('buildState', () => {
  const turns = [
    { role: 'user' as const, text: 'plan the migration', isToolResult: false },
    { role: 'user' as const, text: 'tool output', isToolResult: true },
    { role: 'assistant' as const, text: 'Here is the plan: …', isToolResult: false },
  ]

  test('gives a short draft the last reply it answers', async () => {
    const state = buildState('yes, do it', turns)
    expect(state.recent_user_turns).toEqual(['plan the migration'])
    expect(state.last_assistant_message).toBe('Here is the plan: …')
  })

  test('leaves the last reply off a long draft', async () => {
    const state = buildState(Array(40).fill('word').join(' '), turns)
    expect(state.last_assistant_message).toBeUndefined()
  })
})

describe('scrub', () => {
  test('removes obvious credentials', async () => {
    expect(scrub('key sk-abcdefghijklmnopqrstu here')).toBe('key [REDACTED] here')
    expect(scrub('password: hunter2')).toBe('password: [REDACTED]')
  })
})

describe('parseJevResponse', () => {
  test('reads probabilities and nouls', async () => {
    const answers = parseJevResponse(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          model: { type: 'choice', choice: 'opus', confidence: 0.6, probabilities: { haiku: 0.05, sonnet: 0.15, opus: 0.7, fable: 0.1 } },
          effort: { type: 'choice', choice: 'high', confidence: 0.5, probabilities: { medium: 0.3, high: 0.6, xhigh: 0.1 } },
          alters_sensitive_state: { type: 'noul', noul: 0.12 },
          names_own_model: { type: 'noul', noul: 0.03 },
          continues_earlier_work: { type: 'noul', noul: 0.91 },
        },
      }),
    )

    expect(answers.model.opus).toBe(0.7)
    expect(answers.effort.low).toBe(0)
    expect(answers.risky).toBe(0.12)
    expect(answers.jevModel).toBe('jev-1.13.0')
    expect(answers.continues).toBe(0.91)
  })

  test('fails loudly on an answer without probabilities', async () => {
    expect(() => parseJevResponse(JSON.stringify({ answers: { model: {} } }))).toThrow()
  })
})

describe('keyFromEnvFile', () => {
  test('reads the key, quoted or not', async () => {
    expect(keyFromEnvFile('A=1\nMERGE_GATEWAY_KEY="abc=123"\n')).toBe('abc=123')
    expect(keyFromEnvFile('MERGE_GATEWAY_KEY=plain')).toBe('plain')
    expect(keyFromEnvFile('JEV_API_KEY=first\nMERGE_GATEWAY_KEY=second')).toBe('first')
    expect(keyFromEnvFile('OTHER=1')).toBe('')
  })
})
