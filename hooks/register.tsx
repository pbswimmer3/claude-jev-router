import type { Engine, Register } from 'claude-code'

import type { Choice, Effort, Recommendation, RouteStatus, Tier } from '../types'
import { buildJevRequest, buildState, KEY_NAMES, keyFromEnvFile, parseJevResponse, type JevConfig, type JevRequest } from './jev'
import { needsContext, recommend } from './route'

const MODEL_NAMES: Record<Tier, string> = {
  haiku: 'Haiku 5.5',
  sonnet: 'Sonnet 5.5',
  opus: 'Opus 5.5',
  fable: 'Fable 5.1',
}

// Read when the key is not in the environment and the keyFile option is unset.
const DEFAULT_KEY_FILE = '~/.config/jev-router/.env'

const LOG_KEY = 'log'
const LOG_LIMIT = 500

type LogEntry = {
  at: number
  draft: string
  model: Tier
  effort: Effort
  modelConfidence: number
  effortConfidence: number
  /** The Jev version that answered; the bars are tuned per version. */
  jevModel: string
  /** Whether the draft continued earlier work, so the conversation went to Jev too. */
  usedContext: boolean
  /** The model the message was actually sent on, filled at submit. */
  sentOn?: string
}

const IDLE: RouteStatus = { kind: 'idle' }

const pct = (p: number) => `${Math.round(p * 100)}%`

// "Jev 97%" when the card shows Jev's own pick; "Jev said Haiku 86%" when a step-up,
// guard or your own instruction changed it, so a low number never sits beside a pick Jev didn't make.
function said<T extends string>(choice: Choice<T>, name: (value: T) => string): string {
  return choice.value === choice.jev.value
    ? `${pct(choice.jev.confidence)}`
    : `Jev said ${name(choice.jev.value)} ${pct(choice.jev.confidence)}`
}

function describe(rec: Recommendation): string {
  const parts = [`model ${said(rec.model, v => MODEL_NAMES[v])}`, `effort ${said(rec.effort, v => v)}`]

  return [parts.join(', '), ...rec.reasons].join(' · ')
}

async function getStatus($: Engine): Promise<RouteStatus> {
  const { value = IDLE } = await $.state.get({ plugin: 'jev-router', key: 'status' })

  return value
}

async function setStatus($: Engine, value: RouteStatus) {
  await $.state.set({ plugin: 'jev-router', key: 'status' }, value)
}

async function log($: Engine, edit: (entries: LogEntry[]) => LogEntry[]) {
  const entries = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
  await $.store.set(LOG_KEY, edit(entries).slice(-LOG_LIMIT))
}

// The environment first, then a .env file holding one of KEY_NAMES.
async function gatewayKey($: Engine, keyFile: string): Promise<string> {
  const fromEnv = ((await $.env.get('JEV_API_KEY')) ?? '') || ((await $.env.get('MERGE_GATEWAY_KEY')) ?? '')

  if (fromEnv !== '' || keyFile === '') {
    return fromEnv
  }

  try {
    const home = (await $.env.get('HOME')) ?? ''
    const path = keyFile.startsWith('~/') ? `${home}${keyFile.slice(1)}` : keyFile

    return keyFromEnvFile(await $.fs.read(path))
  } catch {
    return ''
  }
}

async function ask($: Engine, request: JevRequest) {
  const response = await $.http.fetch(request.url, request.init)

  if (!response.ok) {
    throw new Error(`Jev answered HTTP ${response.status}`)
  }

  return parseJevResponse(response.text)
}

async function route($: Engine, config: Omit<JevConfig, 'apiKey'>, keyFile: string) {
  const { text: draft } = await $.prompt.read()

  if (draft.trim() === '') {
    $.ui.toast('Type a message first, then route it.')

    return
  }

  await setStatus($, { kind: 'routing' })

  try {
    const apiKey = await gatewayKey($, keyFile)

    if (apiKey === '') {
      throw new Error(`no ${KEY_NAMES.join(' or ')} in the environment or in ${keyFile}`)
    }

    const messages = await $.session.messages()
    const turns = messages.map(m => ({ role: m.role, text: m.text, isToolResult: (m.toolResults?.length ?? 0) > 0 }))
    const alone = await ask($, buildJevRequest({ ...config, apiKey }, buildState(draft, []), true))
    const withContext = needsContext(alone.continues, turns.some(t => !t.isToolResult && t.text.trim() !== ''))
    const answers = withContext ? await ask($, buildJevRequest({ ...config, apiKey }, buildState(draft, turns))) : alone
    const rec = recommend(answers, draft)
    const at = await $.clock.now()
    await setStatus($, { kind: 'ready', rec, draft })
    await log($, entries => [
      ...entries,
      {
        at,
        draft: draft.slice(0, 500),
        model: rec.model.value,
        effort: rec.effort.value,
        modelConfidence: rec.model.confidence,
        effortConfidence: rec.effort.confidence,
        jevModel: answers.jevModel,
        usedContext: withContext,
      },
    ])
  } catch (error) {
    await setStatus($, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

export const register: Register = (on, options) => {
  const keyFile = typeof options.keyFile === 'string' && options.keyFile !== '' ? options.keyFile : DEFAULT_KEY_FILE
  const config = {
    endpoint: typeof options.jevEndpoint === 'string' ? options.jevEndpoint : 'https://api-gateway.merge.dev/v1/decisions',
    model: typeof options.jevModel === 'string' ? options.jevModel : 'typesafe/jev-1.13',
  }

  on('prompt.submit', async ($, e, next) => {
    const sentOn = await $.session.model()
    await log($, entries => {
      const last = entries.at(-1)

      return last && last.sentOn === undefined ? [...entries.slice(0, -1), { ...last, sentOn }] : entries
    })
    await setStatus($, IDLE)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const current = await getStatus($)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (current.kind === 'idle') {
      if (e.props.isWorking) {
        return next(e)
      }

      return (
        <Box>
          <Button key="route" label="Route with Jev" hotkey="r" onPress={() => route($, config, keyFile)} />
        </Box>
      )
    }

    if (current.kind === 'routing') {
      return (
        <Box>
          <Text dimColor>Asking Jev…</Text>
        </Box>
      )
    }

    if (current.kind === 'error') {
      return (
        <Box>
          <Text color="red">Jev: {current.message} </Text>
          <Button key="dismiss" label="Dismiss" onPress={() => setStatus($, IDLE)} />
        </Box>
      )
    }

    const { rec } = current

    return (
      <Box flexDirection="column">
        <Text>
          <Text dimColor>Jev suggests </Text>
          <Text bold>
            {MODEL_NAMES[rec.model.value]} · {rec.effort.value[0].toUpperCase() + rec.effort.value.slice(1)} effort
          </Text>
          <Text dimColor>
            {'  '}
            {describe(rec)}
          </Text>
        </Text>
        <Box>
          <Text dimColor>Set it in the model picker before you send. </Text>
          <Button key="dismiss" label="Dismiss" hotkey="d" onPress={() => setStatus($, IDLE)} />
        </Box>
      </Box>
    )
  })
}
