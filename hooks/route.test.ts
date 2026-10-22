import { describe, expect, test } from 'claude-code/testing'

import { decide, MODEL_BARS, namedEffort, needsContext, recommend, TIERS } from './route'

describe('decide', () => {
  test('keeps a pick that clears its bar', async () => {
    const pick = decide(TIERS, { haiku: 0.97, sonnet: 0.03 }, MODEL_BARS, 'opus')
    expect(pick).toEqual({ value: 'haiku', confidence: 0.97, isFallback: false, jev: { value: 'haiku', confidence: 0.97 } })
  })

  test('steps up to the stronger of the top two below the bar', async () => {
    const pick = decide(TIERS, { haiku: 0.55, sonnet: 0.4, opus: 0.05 }, MODEL_BARS, 'opus')
    expect(pick.value).toBe('sonnet')
    expect(pick.isFallback).toBe(true)
  })

  test('keeps the top pick when it is already the stronger one', async () => {
    const pick = decide(TIERS, { opus: 0.35, sonnet: 0.3 }, MODEL_BARS, 'opus')
    expect(pick.value).toBe('opus')
    expect(pick.isFallback).toBe(false)
  })

  test('never steps up past the ceiling', async () => {
    const pick = decide(TIERS, { opus: 0.35, fable: 0.3 }, MODEL_BARS, 'opus')
    expect(pick.value).toBe('opus')
  })

  test('breaks a tie toward the more capable option', async () => {
    const pick = decide(TIERS, { sonnet: 0.5, opus: 0.5 }, MODEL_BARS, 'opus')
    expect(pick.value).toBe('opus')
  })
})

describe('recommend', () => {
  const calm = { model: { sonnet: 0.9 }, effort: { medium: 0.7 }, risky: 0.1, namesOwn: 0 }

  test('passes clear answers through', async () => {
    const rec = recommend(calm, 'tidy this paragraph')
    expect(rec.model.value).toBe('sonnet')
    expect(rec.effort.value).toBe('medium')
    expect(rec.reasons).toEqual([])
  })

  test('raises a risky draft to at least opus at high effort', async () => {
    const rec = recommend({ ...calm, risky: 0.9 }, 'rotate the prod database credentials')
    expect(rec.model.value).toBe('opus')
    expect(rec.effort.value).toBe('high')
  })

  test('never lowers a risky draft that is already above the floor', async () => {
    const rec = recommend({ model: { fable: 0.9 }, effort: { max: 0.9 }, risky: 0.9, namesOwn: 0 }, 'migrate billing')
    expect(rec.model.value).toBe('fable')
    expect(rec.effort.value).toBe('max')
  })

  test('defers to a model and effort the draft directs', async () => {
    const rec = recommend({ ...calm, namesOwn: 0.9 }, 'use opus on max effort for this refactor')
    expect(rec.model.value).toBe('opus')
    expect(rec.effort.value).toBe('max')
    expect(rec.reasons).toContain('you asked for opus; Jev would pick sonnet')
  })

  test('ignores a model named for subagents, even when Jev reads direction', async () => {
    const rec = recommend({ ...calm, model: { opus: 0.9 }, namesOwn: 0.8 }, 'plan it; each agent should be a Sonnet agent')
    expect(rec.model.value).toBe('opus')
  })

  test('steps a 0.9 haiku pick up to sonnet', async () => {
    const rec = recommend({ ...calm, model: { haiku: 0.9, sonnet: 0.1 } }, 'can you check the website?')
    expect(rec.model.value).toBe('sonnet')
  })

  test('ignores a model named as subject matter', async () => {
    const rec = recommend({ ...calm, namesOwn: 0.1 }, 'compare opus and sonnet pricing')
    expect(rec.model.value).toBe('sonnet')
    expect(rec.namedModel).toBeUndefined()
  })
})

describe('namedEffort', () => {
  test('reads both spellings', async () => {
    expect(namedEffort('do it at high effort')).toBe('high')
    expect(namedEffort('effort: xhigh please')).toBe('xhigh')
    expect(namedEffort('a high-quality draft')).toBeUndefined()
  })
})

describe('needsContext', () => {
  test('attaches the conversation only to a continuation', async () => {
    expect(needsContext(0.96, true)).toBe(true)
    expect(needsContext(0.33, true)).toBe(false)
    expect(needsContext(0.96, false)).toBe(false)
    expect(needsContext(undefined, true)).toBe(false)
  })
})
