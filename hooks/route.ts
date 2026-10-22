// Pure decision logic: turns Jev's probabilities into one model + effort pick.
// No `$` here, so it is unit-testable on its own.

import type { Choice, Effort, Recommendation, Tier } from '../types'

export type { Choice, Effort, Recommendation, Tier }

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type JevAnswers = {
  model: Partial<Record<Tier, number>>
  effort: Partial<Record<Effort, number>>
  /** Noul: touches production, credentials, permissions, billing or something irreversible. */
  risky: number
  /** Noul: the author's own words choose the model or effort. */
  namesOwn: number
}

// A pick must clear its bar; cheaper picks need more certainty. Below the bar,
// take the more capable of the top two (Pulumi's rule), but never step up into
// the top tier: fable and max come only from a direct pick.
// Bars from the 2026-10-22 eval on jev-1.13 (58 public prompts + 120 real Claude Code prompts):
// haiku/sonnet raised from 0.85/0.6 (+7 to +10 pts exact, under-routing 22% -> 10%);
// low/medium lowered from 0.8/0.55 to 0.5/0.3 across three eval sets (2026-10-22 overnight,
// with gated context: effort exact +6 to +8 pts on real history, +4 to +6 on the graded set).
// Retune if the Jev version changes.
export const MODEL_BARS: Record<Tier, number> = { haiku: 0.95, sonnet: 0.85, opus: 0.4, fable: 0.3 }
export const EFFORT_BARS: Record<Effort, number> = { low: 0.5, medium: 0.3, high: 0.4, xhigh: 0.35, max: 0.3 }
export const MODEL_CEILING: Tier = 'opus'
export const EFFORT_CEILING: Effort = 'xhigh'
export const RISKY_BAR = 0.7
export const NAMES_OWN_BAR = 0.5
// The conversation is attached only when the draft continues earlier work (GATE in rubric.ts).
export const CONTEXT_BAR = 0.4

export function needsContext(continues: number | undefined, hasTurns: boolean): boolean {
  return hasTurns && (continues ?? 0) >= CONTEXT_BAR
}

export function decide<T extends string>(
  order: readonly T[],
  probs: Partial<Record<T, number>>,
  bars: Record<T, number>,
  ceiling: T,
): Choice<T> {
  const ranked = order
    .map(value => ({ value, p: probs[value] ?? 0 }))
    .sort((a, b) => b.p - a.p || order.indexOf(b.value) - order.indexOf(a.value))
  const [top, second] = ranked

  if (top === undefined) {
    throw new Error('no options to decide between')
  }

  const isStronger = second !== undefined && second.p > 0 && order.indexOf(second.value) > order.indexOf(top.value)
  const isAllowed = second !== undefined && order.indexOf(second.value) <= order.indexOf(ceiling)

  const jev = { value: top.value, confidence: top.p }

  if (top.p >= bars[top.value] || !isStronger || !isAllowed) {
    return { value: top.value, confidence: top.p, isFallback: false, jev }
  }

  return { value: second.value, confidence: second.p, isFallback: true, jev }
}

function atLeast<T extends string>(order: readonly T[], pick: Choice<T>, floor: T): Choice<T> {
  return order.indexOf(pick.value) >= order.indexOf(floor) ? pick : { ...pick, value: floor, isFallback: true }
}

// Only an instruction about this task counts ("use opus", "switch to haiku"), not a
// mention ("each agent should be a Sonnet agent", "compare sonnet and opus").
const NAMED_MODEL = /\b(?:use|using|with|on|switch to|run (?:this )?(?:on|with))\s+(haiku|sonnet|opus|fable)\b/i
const NAMED_EFFORT = /\b(low|medium|high|xhigh|max)\s+effort\b|\beffort[:=\s]+(low|medium|high|xhigh|max)\b/i

export function namedModel(draft: string): Tier | undefined {
  const match = draft.match(NAMED_MODEL)

  return match?.[1] === undefined ? undefined : (match[1].toLowerCase() as Tier)
}

export function namedEffort(draft: string): Effort | undefined {
  const match = draft.match(NAMED_EFFORT)
  const level = match?.[1] ?? match?.[2]

  return level === undefined ? undefined : (level.toLowerCase() as Effort)
}

export function recommend(answers: JevAnswers, draft: string): Recommendation {
  let model = decide(TIERS, answers.model, MODEL_BARS, MODEL_CEILING)
  let effort = decide(EFFORTS, answers.effort, EFFORT_BARS, EFFORT_CEILING)
  const reasons: string[] = []

  if (model.isFallback) reasons.push('unsure, stepped up a model')
  if (effort.isFallback) reasons.push('unsure, stepped up effort')

  if (answers.risky >= RISKY_BAR) {
    model = atLeast(TIERS, model, 'opus')
    effort = atLeast(EFFORTS, effort, 'high')
    reasons.push('touches production, credentials or billing')
  }

  // Jev decides whether the draft is directing a model; the regex only reads which one.
  const isDirected = answers.namesOwn >= NAMES_OWN_BAR
  const named = isDirected ? namedModel(draft) : undefined
  const namedLevel = isDirected ? namedEffort(draft) : undefined

  if (named !== undefined) {
    if (named !== model.value) reasons.push(`you asked for ${named}; Jev would pick ${model.value}`)
    model = { ...model, value: named, confidence: 1, isFallback: false }
  }

  if (namedLevel !== undefined) {
    if (namedLevel !== effort.value) reasons.push(`you asked for ${namedLevel} effort; Jev would pick ${effort.value}`)
    effort = { ...effort, value: namedLevel, confidence: 1, isFallback: false }
  }

  return { model, effort, reasons, namedModel: named }
}
