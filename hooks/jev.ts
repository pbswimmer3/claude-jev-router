// Builds the Jev (TypeSafe System One) request and reads its answer.
// Pure: register.tsx does the fetch. Wire format: docs.typesafe.ai/api/system-one, which
// Merge Gateway's /v1/decisions and local Kev's /v1/systemone both take.

import { GATE, QUESTIONS } from './rubric'
import { EFFORTS, TIERS, type Effort, type JevAnswers, type Tier } from './route'

export type JevConfig = { apiKey: string; endpoint: string; model: string }

export type JevRequest = {
  url: string
  init: { method: string; headers: Record<string, string>; body: string }
}

/** The conversation around the draft, as `$.session.messages()` gives it. */
export type Turn = { role: 'user' | 'assistant'; text: string; isToolResult: boolean }

/** Env vars (or .env lines) the key is read from, first match wins. */
export const KEY_NAMES = ['JEV_API_KEY', 'MERGE_GATEWAY_KEY'] as const

/** Reads the first of KEY_NAMES out of a .env file's text; '' when none is there. */
export function keyFromEnvFile(text: string): string {
  const lines = text.split(/\r?\n/).map(l => l.trim())

  for (const name of KEY_NAMES) {
    const line = lines.find(l => l.startsWith(`${name}=`))

    if (line !== undefined) {
      return line.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    }
  }

  return ''
}

const DRAFT_LIMIT = 4000
const TURN_LIMIT = 600
const ASSISTANT_LIMIT = 800
const SHORT_DRAFT_WORDS = 30

// Obvious credentials never leave the machine.
const SECRETS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)\S+/gi,
]

export function scrub(text: string): string {
  return SECRETS.reduce((out, pattern) => out.replace(pattern, (match, prefix) =>
    typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'), text)
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text)

export function buildState(draft: string, turns: readonly Turn[]) {
  const said = turns.filter(t => !t.isToolResult && t.text.trim() !== '')
  const recentUser = said.filter(t => t.role === 'user').slice(-2)
  const lastAssistant = said.filter(t => t.role === 'assistant').at(-1)
  const isShort = draft.trim().split(/\s+/).length < SHORT_DRAFT_WORDS

  return {
    request: clip(scrub(draft), DRAFT_LIMIT),
    ...(recentUser.length > 0 && { recent_user_turns: recentUser.map(t => clip(scrub(t.text), TURN_LIMIT)) }),
    ...(isShort && lastAssistant && { last_assistant_message: clip(scrub(lastAssistant.text), ASSISTANT_LIMIT) }),
    session: { harness: 'Claude Code' },
  }
}

/** `withGate` adds the continues-earlier-work question; it goes on the draft-alone call. */
export function buildJevRequest(config: JevConfig, state: ReturnType<typeof buildState>, withGate = false): JevRequest {
  return {
    url: config.endpoint,
    init: {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, state, questions: withGate ? { ...QUESTIONS, ...GATE } : QUESTIONS }),
    },
  }
}

type ChoiceAnswer = { probabilities?: Record<string, number> }
type NoulAnswer = { noul?: number }

function probabilities<T extends string>(order: readonly T[], answer: ChoiceAnswer | undefined): Partial<Record<T, number>> {
  const probs = answer?.probabilities

  if (probs === undefined) {
    throw new Error('Jev answer has no probabilities')
  }

  return Object.fromEntries(order.map(option => [option, probs[option] ?? 0])) as Partial<Record<T, number>>
}

export function parseJevResponse(text: string): JevAnswers & { jevModel: string; continues?: number } {
  const body = JSON.parse(text) as {
    model?: string
    answers?: {
      model?: ChoiceAnswer
      effort?: ChoiceAnswer
      alters_sensitive_state?: NoulAnswer
      names_own_model?: NoulAnswer
      continues_earlier_work?: NoulAnswer
    }
  }
  const answers = body.answers

  if (answers === undefined) {
    throw new Error('Jev answered without answers')
  }

  return {
    model: probabilities<Tier>(TIERS, answers.model),
    effort: probabilities<Effort>(EFFORTS, answers.effort),
    risky: answers.alters_sensitive_state?.noul ?? 0,
    namesOwn: answers.names_own_model?.noul ?? 0,
    jevModel: body.model ?? 'unknown',
    continues: answers.continues_earlier_work?.noul,
  }
}
