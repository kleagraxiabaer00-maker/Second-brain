import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  Register,
  TurnStepChunk,
  TurnStepResult,
} from 'claude-code'

import type { AgentCard, BrainEvent, HandoverTask, Role, Route, Tally, Tier } from '../types'
import { parse, serialize, TEMPLATE, type HandoverDoc } from './handover'
import {
  classify,
  clock,
  compact,
  costOf,
  EMPTY_TALLY,
  isRetryable,
  readConfig,
  type Config,
  summarise,
  tokensOf,
  usd,
} from './shared'

const routeAtom = atom({ plugin: 'SecondBrainSystem', key: 'route' } as const, {
  tier: 'heavy',
  reason: 'no prompt yet',
  isForced: false,
} as Route)
const tallyAtom = atom({ plugin: 'SecondBrainSystem', key: 'tally' } as const, EMPTY_TALLY)
const allTimeAtom = atom({ plugin: 'SecondBrainSystem', key: 'allTime' } as const, EMPTY_TALLY)
const roleAtom = atom({ plugin: 'SecondBrainSystem', key: 'role' } as const, 'off' as Role)
const agentsAtom = atom({ plugin: 'SecondBrainSystem', key: 'agents' } as const, [] as AgentCard[])
const tasksAtom = atom({ plugin: 'SecondBrainSystem', key: 'tasks' } as const, [] as HandoverTask[])
const brainAtom = atom({ plugin: 'SecondBrainSystem', key: 'brain' } as const, [] as BrainEvent[])
const buildsAtom = atom(
  { plugin: 'SecondBrainSystem', key: 'builds' } as const,
  {} as Record<string, string>,
)
const themeAtom = atom({ plugin: 'SecondBrainSystem', key: 'theme' } as const, 'default')

const PANE = 'second-brain'
const PLAN_TOOL = 'mcp__SecondBrainSystem__handover_plan'

const SEEDS: Record<string, string> = {
  'memory.md': '# Memory\n\nDurable facts about me, my preferences and decisions.\n',
  'soul.md': '# Soul\n\nWho I am, what I value, how I like to work.\n',
  'projects.md': '# Projects\n\nWhat I am building, its status, and what comes next.\n',
  'handover.md': TEMPLATE,
}

const ROLE_COLOR = { planner: 'planMode', builder: 'autoAccept', off: 'inactive' } as const
const KIND_COLOR = { created: 'success', modified: 'warning', deleted: 'error' } as const
const STATE_MARK = { open: '○', claimed: '◐', done: '●', failed: '✗' } as const

/** Files the brain monitor ignores: the sync channel has its own section. */
const UNWATCHED = /^(handover\.md|\..*)$/

type Context = { root: string; who: string; cwd: string }
type Snapshot = { mtimeMs: number; size: number; lines: string[] }

/** Forwards a `turn.step` stream chunk by chunk and evaluates to its result. */
async function* relay(stream: HookStream<TurnStepChunk, TurnStepResult>) {
  for (;;) {
    const step = await stream.next()
    if (step.done) {
      return (step.value as TurnStepResult | undefined) ?? (await stream.result)
    }
    yield step.value
  }
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

function builderPrompt(task: HandoverTask, ctx: Context): string {
  return [
    `You are a Builder agent working from the shared handover file ${ctx.root}/handover.md.`,
    `Your task (${task.id}): ${task.text}`,
    `Work in ${ctx.cwd}. Make the code changes the task asks for and verify them as far as you can.`,
    'Do not edit handover.md yourself: the system records your result there when you finish.',
    'End your answer with one line that starts with "RESULT:" summarising what changed, or "FAILED:" and why.',
  ].join('\n')
}

// Session state the hooks share; a reload starts it over, as it does `register`.
let config: Config = readConfig({})
let ctx: Context | null = null
let turnSaved = 0
let turnSwap = ''
let isTicking = false
let lastCardWrite = 0
let lastHandoverMtime = -1

async function record(
  $: EngineInterface,
  result: TurnStepResult,
  sent: string,
  baseline: string,
  tier: Tier,
  isFallback: boolean,
) {
  if (result.usage === null) {
    return
  }
  const answeredBy = result.usage.model || sent
  const spent = costOf(result.usage, answeredBy)
  // Savings are measured against the model the engine would have sent.
  const saved = costOf(result.usage, baseline) - spent
  const tokens = tokensOf(result.usage)
  turnSaved += saved
  const add = (t: Tally): Tally => ({
    lightTokens: t.lightTokens + (tier === 'light' ? tokens : 0),
    heavyTokens: t.heavyTokens + (tier === 'heavy' ? tokens : 0),
    lightSteps: t.lightSteps + (tier === 'light' ? 1 : 0),
    heavySteps: t.heavySteps + (tier === 'heavy' ? 1 : 0),
    fallbacks: t.fallbacks + (isFallback ? 1 : 0),
    savedUsd: t.savedUsd + saved,
    spentUsd: t.spentUsd + spent,
  })
  await update($, tallyAtom, add)
  const all = await update($, allTimeAtom, add)
  await $.store.set('allTime', all)
}

/** Every write takes an atomic `mkdir` lock, so two Builders never claim one task. */
async function withLock<T>($: EngineInterface, root: string, work: () => Promise<T>): Promise<T> {
  const lock = `${root}/.handover.lock`
  for (let attempt = 0; attempt < 50; attempt++) {
    const taken = await $.process.run(['mkdir', lock])
    if (taken.exitCode === 0) {
      try {
        return await work()
      } finally {
        await $.process.run(['rmdir', lock])
      }
    }
    // A lock older than 30s belongs to a session that died mid-write.
    const held = await $.fs.stat(lock).catch(() => undefined)
    if (held && (await $.clock.now()) - held.mtimeMs > 30_000) {
      await $.process.run(['rmdir', lock])
      continue
    }
    await $.clock.sleep(100 + Math.floor(Math.random() * 150))
  }
  throw new Error('handover.md stayed locked for too long')
}

async function readHandover($: EngineInterface, root: string): Promise<HandoverDoc> {
  const path = `${root}/handover.md`

  return parse((await $.fs.exists(path)) ? await $.fs.read(path) : TEMPLATE)
}

/** Read-modify-write under the lock, landing by rename so no reader sees half a file. */
async function mutate(
  $: EngineInterface,
  c: Context,
  change: (doc: HandoverDoc) => string | undefined,
): Promise<void> {
  await withLock($, c.root, async () => {
    const doc = await readHandover($, c.root)
    const entry = change(doc)
    if (entry) {
      const stamp = new Date(await $.clock.now()).toISOString().slice(0, 19).replace('T', ' ')
      doc.log.push(`- ${stamp} @${c.who}: ${entry}`)
    }
    const temp = `${c.root}/.handover.${c.who}.tmp`
    await $.fs.write(temp, serialize(doc))
    const moved = await $.process.run(['mv', '-f', temp, `${c.root}/handover.md`])
    if (moved.exitCode !== 0) {
      throw new Error(`could not replace handover.md: ${moved.stderr.trim()}`)
    }
  })
}

async function writeCard($: EngineInterface, status: string, task?: string) {
  if (!ctx) return
  const card: AgentCard = {
    id: ctx.who,
    role: await read($, roleAtom),
    status,
    task,
    updatedAt: await $.clock.now(),
  }
  lastCardWrite = card.updatedAt
  await $.fs.write(`${ctx.root}/agents/${ctx.who}.json`, JSON.stringify(card, null, 2))
}

/** Re-reads the shared files: every agent's card and, when it changed, handover.md. */
async function refresh($: EngineInterface) {
  if (!ctx) return
  const now = await $.clock.now()
  const entries = await $.fs.list(`${ctx.root}/agents`).catch(() => [])
  const cards: AgentCard[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    try {
      const card = JSON.parse(await $.fs.read(`${ctx.root}/agents/${entry.name}`)) as AgentCard
      // Cards are heartbeats: two minutes of silence means the session is gone.
      if (now - card.updatedAt < 120_000) cards.push(card)
    } catch {
      // A card mid-write; the next tick reads it.
    }
  }
  await update($, agentsAtom, () => cards.sort((a, b) => a.id.localeCompare(b.id)))

  const stat = await $.fs.stat(`${ctx.root}/handover.md`).catch(() => undefined)
  if (stat && stat.mtimeMs !== lastHandoverMtime) {
    lastHandoverMtime = stat.mtimeMs
    const before = await read($, tasksAtom)
    const { tasks } = await readHandover($, ctx.root)
    await update($, tasksAtom, () => tasks)
    if ((await read($, roleAtom)) === 'planner') {
      for (const t of tasks) {
        const was = before.find(b => b.id === t.id)
        if (was && was.state !== t.state && (t.state === 'done' || t.state === 'failed')) {
          $.ui.toast(`${t.id} ${t.state} by @${t.owner}: ${t.note ?? t.text}`)
        }
      }
    }
  }
}

/** A Builder claims the first open task under the lock and hands it to a background subagent. */
async function claimNext($: EngineInterface) {
  const c = ctx
  if (!c || (await read($, roleAtom)) !== 'builder') return
  if (Object.keys(await read($, buildsAtom)).length >= config.maxBuilders) return

  let claimed: HandoverTask | undefined
  await mutate($, c, doc => {
    const task = doc.tasks.find(t => t.state === 'open')
    if (!task) return undefined
    Object.assign(task, { state: 'claimed', owner: c.who, note: undefined })
    claimed = { ...task }

    return `claimed ${task.id}`
  })
  if (!claimed) return
  const task = claimed

  const spawned = await $.agent.spawn({
    prompt: builderPrompt(task, c),
    description: `Build ${task.id}`,
    subagentType: 'general-purpose',
  })
  if (spawned.deny !== undefined || spawned.agentId === undefined) {
    const why = spawned.deny ?? 'no agent started'
    await mutate($, c, doc => {
      const t = doc.tasks.find(x => x.id === task.id)
      if (t) Object.assign(t, { state: 'open', owner: undefined, note: undefined })

      return `released ${task.id}: ${why}`
    })
    return
  }
  const agentId = spawned.agentId
  await update($, buildsAtom, b => ({ ...b, [agentId]: task.id }))
  await writeCard($, `building ${task.id}`, task.text)
  $.ui.log(`🔨 Builder ${c.who} took ${task.id}: ${task.text}`)
}

async function tick($: EngineInterface) {
  if (isTicking) return
  isTicking = true
  try {
    await refresh($)
    await claimNext($)
    if ((await $.clock.now()) - lastCardWrite > 15_000) {
      const active = Object.values(await read($, buildsAtom))
      await writeCard($, active.length ? `building ${active.join(', ')}` : 'idle')
    }
  } catch (error) {
    $.ui.log(`SecondBrain sync: ${errorText(error)}`, { to: 'debug' })
  } finally {
    isTicking = false
  }
}

async function addTasks($: EngineInterface, texts: readonly string[]): Promise<string[]> {
  const c = ctx
  if (!c) throw new Error('the second brain folder is not ready yet')
  const added: string[] = []
  await mutate($, c, doc => {
    let n = 1 + Math.max(0, ...doc.tasks.map(t => Number(t.id.slice(1)) || 0))
    for (const text of texts) {
      const clean = text.replace(/\s+/g, ' ').replace(/ — /g, ' - ').trim()
      if (!clean) continue
      const id = `T${n++}`
      doc.tasks.push({ id, state: 'open', text: clean })
      added.push(id)
    }

    return added.length ? `planned ${added.join(', ')}` : undefined
  })
  await refresh($)

  return added
}

async function setRole($: EngineInterface, role: Role) {
  await update($, roleAtom, () => role)
  await writeCard($, role === 'builder' ? 'waiting for tasks' : role === 'planner' ? 'planning' : 'idle')
}

async function finishBuild($: EngineInterface, agentId: string, reason: string, answer: string) {
  const c = ctx
  const taskId = (await read($, buildsAtom))[agentId]
  if (!c || taskId === undefined) return
  const { isFailed, note } =
    reason === 'answer' ? summarise(answer) : { isFailed: true, note: `stopped: ${reason}` }
  await mutate($, c, doc => {
    const t = doc.tasks.find(x => x.id === taskId)
    if (t) Object.assign(t, { state: isFailed ? 'failed' : 'done', owner: c.who, note })

    return `${isFailed ? 'failed' : 'finished'} ${taskId}: ${note}`
  })
  await update($, buildsAtom, b => Object.fromEntries(Object.entries(b).filter(([k]) => k !== agentId)))
  await writeCard($, `${isFailed ? 'failed' : 'finished'} ${taskId}`)
  $.ui.toast(`🔨 ${taskId} ${isFailed ? 'failed' : 'done'}: ${note}`)
}

function startMonitor($: EngineInterface, root: string) {
  const known = new Map<string, Snapshot>()
  let isFirst = true
  let isBusy = false

  const scan = async () => {
    if (isBusy) return
    isBusy = true
    try {
      const entries = await $.fs.list(root).catch(() => [])
      const files = entries.filter(
        f => f.kind === 'file' && f.name.endsWith('.md') && !UNWATCHED.test(f.name),
      )
      const events: BrainEvent[] = []
      const now = await $.clock.now()

      for (const file of files) {
        const before = known.get(file.name)
        if (before && before.mtimeMs === file.mtimeMs && before.size === file.size) continue
        const lines = (await $.fs.read(`${root}/${file.name}`).catch(() => '')).split('\n')
        known.set(file.name, { mtimeMs: file.mtimeMs, size: file.size, lines })
        // The first scan only takes a baseline.
        if (isFirst) continue
        if (!before) {
          events.push({ file: file.name, kind: 'created', at: now, delta: `+${lines.length} lines` })
          continue
        }
        const old = new Set(before.lines)
        const fresh = new Set(lines)
        const added = lines.filter(l => !old.has(l)).length
        const removed = before.lines.filter(l => !fresh.has(l)).length
        const sample = lines.find(l => !old.has(l) && l.trim() !== '')?.trim() ?? ''
        events.push({
          file: file.name,
          kind: 'modified',
          at: now,
          delta: `+${added}/-${removed}${sample ? `  “${sample.slice(0, 48)}”` : ''}`,
        })
      }
      for (const name of [...known.keys()]) {
        if (!files.some(f => f.name === name)) {
          known.delete(name)
          events.push({ file: name, kind: 'deleted', at: now, delta: '' })
        }
      }
      isFirst = false
      if (events.length) {
        await update($, brainAtom, list => [...list, ...events].slice(-50))
      }
    } finally {
      isBusy = false
    }
  }

  void scan()
  $.clock.every(2_000, () => void scan())
}

export const register: Register = (on, options) => {
  config = readConfig(options)

  // ── Module 1: the Smart Frugal Router ────────────────────────────────────

  on('prompt.submit', async ($, e, next) => {
    const route = classify(e.text)
    await update($, routeAtom, () => route)
    turnSaved = 0
    turnSwap = ''
    const text = route.isForced ? e.text.replace(/^\s*!(light|heavy)\b\s*/i, '') : e.text

    return next({ ...e, text })
  })

  on('turn.step', async function* ($, e, next) {
    // Subagents (Builders included) keep whatever model they were spawned with.
    if (!config.isRouterOn || e.agentId !== undefined) {
      return yield* next(e)
    }
    const route = await read($, routeAtom)
    const heavy = config.heavyModel || e.model

    if (route.tier === 'heavy') {
      const result = yield* relay(next({ ...e, model: heavy }))
      if (heavy !== e.model) turnSwap = `${e.model} → ${heavy} (heavy: ${route.reason})`
      await record($, result, heavy, e.model, 'heavy', false)

      return result
    }

    const light = config.lightModel
    let yielded = 0
    try {
      const stream = next({ ...e, model: light })
      for (;;) {
        const step = await stream.next()
        if (step.done) {
          const result = (step.value as TurnStepResult | undefined) ?? (await stream.result)
          // No response at all (a 429 or a dropped connection the engine gave up on).
          if (!result || (result.stopReason === null && result.usage === null && yielded === 0)) {
            throw new Error(`no response from ${light}`)
          }
          turnSwap = `${e.model} → ${light} (light: ${route.reason})`
          await record($, result, light, e.model, 'light', false)

          return result
        }
        yielded += 1
        yield step.value
      }
    } catch (error) {
      // Once text has streamed, a retry would show the answer twice: let it surface.
      if (yielded > 0 || next.signal?.aborted) {
        throw error
      }
      const why = isRetryable(error) ? 'rate limit / connection' : 'error'
      $.ui.log(`⚠ SecondBrain router: ${light} failed (${why}), falling back to ${heavy}`)
      turnSwap = `${light} ✗ → ${heavy} (fallback)`
      const result = yield* relay(next({ ...e, model: heavy }))
      await record($, result, heavy, e.model, 'heavy', true)

      return result
    }
  })

  // ── Module 2: Multi-agent sync over handover.md ──────────────────────────

  on('command.run', { command: 'sb-role' }, async ($, e) => {
    const role = e.args.trim().toLowerCase()
    if (role !== 'planner' && role !== 'builder' && role !== 'off') {
      return { text: `Usage: /sb-role planner|builder|off (now: ${await read($, roleAtom)})` }
    }
    await setRole($, role)

    return {
      text:
        role === 'builder'
          ? `This session is now a Builder (${ctx?.who}). It claims open tasks from handover.md and builds them in background subagents (up to ${config.maxBuilders} at once).`
          : role === 'planner'
            ? 'This session is now the Planner. Add tasks with /sb-plan <task>, or ask me to plan and I will post them with the handover_plan tool.'
            : 'This session no longer plans or builds.',
    }
  })

  on('command.run', { command: 'sb-plan' }, async ($, e) => {
    if (!e.args.trim()) return { text: 'Usage: /sb-plan <task for a Builder>' }
    const added = await addTasks($, [e.args])

    return { text: `Added ${added.join(', ')} to handover.md.` }
  })

  on('command.run', { command: 'sb-tasks' }, async $ => {
    await refresh($)
    const tasks = await read($, tasksAtom)
    if (tasks.length === 0) return { text: 'handover.md has no tasks yet.' }

    return {
      text: tasks
        .map(t => `${t.id} [${t.state}] ${t.text}${t.owner ? ` @${t.owner}` : ''}${t.note ? `: ${t.note}` : ''}`)
        .join('\n'),
    }
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const tasks = Array.isArray(e.tasks) ? e.tasks.map(String) : []
    const added = await addTasks($, tasks)

    return { result: `Added ${added.length} task(s) to handover.md: ${added.join(', ')}` }
  })

  // Builder progress: what each background subagent is doing right now.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const taskId = (await read($, buildsAtom))[e.agentId]
      if (taskId && (await $.clock.now()) - lastCardWrite > 3_000) {
        const input = e as unknown as Record<string, unknown>
      const target = input.file_path ?? input.command ?? input.pattern ?? ''
        await writeCard($, `${taskId} · ${e.tool} ${String(target).slice(0, 50)}`.trim())
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId !== undefined) {
        await finishBuild($, e.agentId, e.reason, e.answer)
      } else if (turnSwap !== '') {
        // The router's terminal line: the swap and the running tally.
        const session = await read($, tallyAtom)
        const all = await read($, allTimeAtom)
        $.ui.log(
          `⇄ ${turnSwap} · this turn ${usd(turnSaved)} · session ${usd(session.savedUsd)} · all-time ${usd(all.savedUsd)} saved`,
        )
        $.ui.status(`🧠 saved ${usd(session.savedUsd)}`)
        turnSwap = ''
      }
    } catch (error) {
      $.ui.log(`SecondBrain: ${errorText(error)}`, { to: 'debug' })
    }

    return result
  })

  // ── Module 3: the Second Brain monitor ───────────────────────────────────

  // ── Session start: the brain folder, commands, timers, the pane ─────────

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const home = (await $.env.get('HOME')) ?? ''
    const root = config.root.replace(/^~(?=\/|$)/, home).replace(/\/$/, '')
    for (const [name, text] of Object.entries(SEEDS)) {
      if (!(await $.fs.exists(`${root}/${name}`))) await $.fs.write(`${root}/${name}`, text)
    }
    const sid = (await $.session.id()).replace(/[^a-zA-Z0-9]/g, '').slice(-6)
    ctx = { root, who: `session-${sid}`, cwd: await $.session.cwd() }

    const stored = (await $.store.get('allTime')) as Partial<Tally> | undefined
    await update($, allTimeAtom, () => ({ ...EMPTY_TALLY, ...stored }))
    const theme = (await $.config.list()).find(row => row.key === 'theme')
    await update($, themeAtom, () => String(theme?.value ?? 'default'))

    await $.command.register({ name: 'sb-dash', description: 'SecondBrain: open the dashboard pane' })
    await $.command.register({
      name: 'sb-role',
      description: 'SecondBrain: make this session the planner, a builder, or neither (planner|builder|off)',
    })
    await $.command.register({ name: 'sb-plan', description: 'SecondBrain: add a task to handover.md for a Builder' })
    await $.command.register({ name: 'sb-tasks', description: 'SecondBrain: list the tasks in handover.md' })
    await $.tool.register({
      name: 'handover_plan',
      description:
        'Planner only: append build tasks to the shared ~/.secondbrain/handover.md so Builder sessions pick them up in the background. Each task must be a self-contained instruction.',
      inputSchema: {
        type: 'object',
        properties: { tasks: { type: 'array', items: { type: 'string' }, minItems: 1 } },
        required: ['tasks'],
      },
    })

    startMonitor($, root)
    $.clock.every(2_000, () => void tick($))
    void tick($)
    void $.ui.open({ id: PANE, title: '🧠 Second Brain' })

    return result
  })

  // ── Module 3: the dashboard pane ─────────────────────────────────────────

  on('command.run', { command: 'sb-dash' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: '🧠 Second Brain' })

    return {
      text: opened.isPlaced ? 'Second Brain dashboard opened.' : 'The dashboard is waiting for room: widen the terminal.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns)
    const rows = e.viewport?.rows ?? 40
    const role = await read($, roleAtom)
    const agents = await read($, agentsAtom)
    const tasks = await read($, tasksAtom)
    const brain = await read($, brainAtom)
    const tally = await read($, tallyAtom)
    const allTime = await read($, allTimeAtom)
    const route = await read($, routeAtom)
    const theme = await read($, themeAtom)

    // Savings meter: the light model's share of every routed token.
    const total = tally.lightTokens + tally.heavyTokens
    const barWidth = Math.max(8, width - 4)
    const lightCells = total === 0 ? 0 : Math.round((tally.lightTokens / total) * barWidth)
    const heavyName = config.heavyModel || 'session model'

    const counts = { open: 0, claimed: 0, done: 0, failed: 0 }
    for (const t of tasks) counts[t.state] += 1
    const brainRoom = Math.max(3, rows - 30 - agents.length * 2)

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text color="claude" bold>
            SecondBrainSystem
          </Text>
          <Text dimColor>theme: {theme}</Text>
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor="planMode" paddingX={1}>
          <Text bold color="planMode">
            Active Agents
          </Text>
          <Box gap={1}>
            <Text dimColor>this session:</Text>
            <Text color={ROLE_COLOR[role]} bold>
              {role}
            </Text>
          </Box>
          <Box gap={1}>
            <Button key="role-planner" label="Planner" onPress={() => setRole($, 'planner')} />
            <Button key="role-builder" label="Builder" onPress={() => setRole($, 'builder')} />
            <Button key="role-off" label="Off" onPress={() => setRole($, 'off')} />
          </Box>
          {agents.length === 0 && <Text dimColor>No agents online yet.</Text>}
          {agents.map(a => (
            <Box key={`agent-${a.id}`} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={ROLE_COLOR[a.role]}>● {a.role.padEnd(7)}</Text> {a.id}{' '}
                <Text dimColor>· {a.status}</Text>
              </Text>
              {a.task && (
                <Text dimColor wrap="truncate-end">
                  {'  '}↳ {a.task}
                </Text>
              )}
            </Box>
          ))}
          <Text dimColor>
            tasks: {counts.open} open · {counts.claimed} building · {counts.done} done
            {counts.failed ? ` · ${counts.failed} failed` : ''}
          </Text>
          {tasks.slice(-5).map(t => (
            <Text
              key={`task-${t.id}`}
              wrap="truncate-end"
              color={t.state === 'failed' ? 'error' : t.state === 'done' ? 'success' : 'text'}
            >
              {STATE_MARK[t.state]} {t.id} {t.text}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
          <Text bold color="suggestion">
            Second Brain Monitor
          </Text>
          {brain.length === 0 && (
            <Text dimColor>Watching memory.md, soul.md, projects.md… no edits yet.</Text>
          )}
          {brain.slice(-brainRoom).map(ev => (
            <Text key={`brain-${ev.at}-${ev.file}`} wrap="truncate-end">
              <Text dimColor>{clock(ev.at)}</Text>{' '}
              <Text color={KIND_COLOR[ev.kind]}>{ev.kind.padEnd(8)}</Text> <Text bold>{ev.file}</Text>{' '}
              <Text dimColor>{ev.delta}</Text>
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor="success" paddingX={1}>
          <Text bold color="success">
            Savings Meter
          </Text>
          <Text>
            <Text color="success">{'█'.repeat(lightCells)}</Text>
            <Text color="claude">{'█'.repeat(barWidth - lightCells)}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text color="success">■ Haiku {compact(tally.lightTokens)}</Text> ({tally.lightSteps} req) ·{' '}
            <Text color="claude">
              ■ {heavyName} {compact(tally.heavyTokens)}
            </Text>{' '}
            ({tally.heavySteps} req)
          </Text>
          <Text wrap="truncate-end">
            saved{' '}
            <Text bold color="success">
              {usd(tally.savedUsd)}
            </Text>{' '}
            this session · {usd(allTime.savedUsd)} all-time · spent {usd(tally.spentUsd)}
          </Text>
          <Text dimColor wrap="truncate-end">
            next route: {route.tier} ({route.reason})
            {tally.fallbacks ? ` · ${tally.fallbacks} fallbacks` : ''}
            {config.isRouterOn ? '' : ' · router off'}
          </Text>
        </Box>
      </Box>
    )
  })
}
