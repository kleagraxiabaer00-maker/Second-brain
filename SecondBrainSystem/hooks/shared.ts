import type { ModelUsage, PluginOptions } from 'claude-code'

import type { Route, Tally, Tier } from '../types'

export const EMPTY_TALLY: Tally = {
  lightTokens: 0,
  heavyTokens: 0,
  lightSteps: 0,
  heavySteps: 0,
  fallbacks: 0,
  savedUsd: 0,
  spentUsd: 0,
}

export type Config = {
  root: string
  isRouterOn: boolean
  lightModel: string
  heavyModel: string
  maxBuilders: number
}

export function readConfig(options: PluginOptions): Config {
  return {
    root: String(options.root ?? '~/.secondbrain'),
    isRouterOn: options.router !== false,
    lightModel: String(options.lightModel ?? 'claude-haiku-5-5'),
    heavyModel: String(options.heavyModel ?? 'claude-sonnet-5-5'),
    maxBuilders: Math.max(1, Number(options.maxBuilders ?? 1)),
  }
}

/** USD per million tokens, [input, output], first-party list prices. */
const PRICES: ReadonlyArray<[string, number, number]> = [
  ['claude-haiku-5-5', 0.1, 0.5],
  ['claude-haiku-4-5', 1, 5],
  ['claude-sonnet-5-5', 2, 10],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-opus-5-5', 4, 20],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4', 5, 25],
  ['claude-fable-5', 10, 50],
]

export function priceOf(model: string): [number, number] {
  const id = model.toLowerCase().replace(/^.*?(claude-)/, '$1')
  const hit = PRICES.find(([prefix]) => id.startsWith(prefix))
  if (hit) {
    return [hit[1], hit[2]]
  }
  if (id.includes('haiku')) return [0.1, 0.5]
  if (id.includes('sonnet')) return [2, 10]

  return [4, 20]
}

/** What `usage` costs on `model`: cache writes at 1.25x input, cache reads at 0.1x. */
export function costOf(usage: ModelUsage, model: string): number {
  const [input, output] = priceOf(model)

  return (
    (usage.input_tokens * input +
      usage.cache_creation_input_tokens * input * 1.25 +
      usage.cache_read_input_tokens * input * 0.1 +
      usage.output_tokens * output) /
    1_000_000
  )
}

export function tokensOf(usage: ModelUsage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  )
}

export function usd(value: number): string {
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`

  return String(n)
}

export function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19)
}


const LIGHT: ReadonlyArray<[RegExp, string]> = [
  [/\bgit\s+(status|log|diff|show|branch|stash list)\b/i, 'git read'],
  [/\b(read|open|show|cat|view|print|list|ls)\b[^.?!]{0,60}\b(file|files|folder|dir|directory|\w+\.\w{1,5})\b/i, 'file read'],
  [/\b(markdown|readme|changelog|\.md\b|notes?|docs?)\b/i, 'markdown edit'],
  [/\b(comment|comments|docstring|jsdoc|typo|spelling|reword|rephrase|rename|format)\b/i, 'comments/wording'],
]

const HEAVY =
  /\b(implement|refactor|debug|bug|crash|fix|architect\w*|design|algorithm|optimi[sz]e|performance|migrat\w*|tests?|security|race|concurren\w*|build|feature|integrat\w*|why|explain how|plan)\b/i

/** Cheap keyword triage of a prompt: light only when a light signal fires and no heavy one does. */
export function classify(text: string): Route {
  const forced = /^\s*!(light|heavy)\b/i.exec(text)
  if (forced) {
    return { tier: (forced[1] ?? 'heavy').toLowerCase() as Tier, reason: 'forced by !prefix', isForced: true }
  }
  if (text.length > 600) {
    return { tier: 'heavy', reason: 'long prompt', isForced: false }
  }
  const heavy = HEAVY.exec(text)
  if (heavy) {
    return { tier: 'heavy', reason: `"${heavy[0]}"`, isForced: false }
  }
  const light = LIGHT.find(([pattern]) => pattern.test(text))

  return light
    ? { tier: 'light', reason: light[1], isForced: false }
    : { tier: 'heavy', reason: 'no light signal', isForced: false }
}

export function isRetryable(error: unknown): boolean {
  const text = String((error as { message?: unknown })?.message ?? error)

  return /429|rate.?limit|overloaded|529|ECONN|ETIMEDOUT|socket|network|connection|fetch failed/i.test(
    text,
  )
}


export function summarise(answer: string): { isFailed: boolean; note: string } {
  const line =
    answer.split('\n').reverse().find(l => /^\s*(RESULT|FAILED):/i.test(l)) ??
    answer.split('\n').find(l => l.trim() !== '') ??
    'finished'
  const isFailed = /^\s*FAILED:/i.test(line)
  const note = line.replace(/^\s*(RESULT|FAILED):\s*/i, '').replace(/\s+—\s+/g, ' - ').trim()

  return { isFailed, note: note.length > 140 ? `${note.slice(0, 137)}...` : note }
}
