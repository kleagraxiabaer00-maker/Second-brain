import type { HandoverTask, TaskState } from '../types'

/**
 * handover.md is the one channel between sessions. Tasks are checklist lines
 * any human or agent can read and edit:
 *
 *   - [ ] (T1) Outline the parser                      open
 *   - [~] (T2) Build the parser — @builder-1a2b         claimed
 *   - [x] (T3) Wire the CLI — @builder-1a2b: done, 3 files   done
 *   - [!] (T4) Ship it — @builder-1a2b: tests failed    failed
 *
 * Every write takes an atomic `mkdir` lock and lands by rename, so two
 * Builders never claim the same task and a reader never sees half a file.
 */

const MARK: Record<TaskState, string> = { open: ' ', claimed: '~', done: 'x', failed: '!' }
const STATE: Record<string, TaskState> = { ' ': 'open', '~': 'claimed', x: 'done', X: 'done', '!': 'failed' }
const LINE = /^\s*[-*]\s+\[([ ~xX!])\]\s*(?:\((T\d+)\)\s*)?(.*?)(?:\s+—\s+@(\S+?)(?::\s*(.*))?)?\s*$/

export type Section = { title: string; lines: string[] }
export type HandoverDoc = { head: string[]; sections: Section[]; tasks: HandoverTask[]; log: string[] }

export const TEMPLATE = `# Handover

Planner sessions add tasks below (\`/sb-plan <task>\`, or edit by hand: \`- [ ] task\`).
Builder sessions (\`/sb-role builder\`) claim open tasks, build them in the background and report back here.

## Tasks

## Notes

## Log
`

export function parse(text: string): HandoverDoc {
  const doc: HandoverDoc = { head: [], sections: [], tasks: [], log: [] }
  let current: Section | null = null
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading) {
      current = { title: (heading[1] ?? '').trim(), lines: [] }
      doc.sections.push(current)
      continue
    }
    if (current === null) {
      doc.head.push(line)
      continue
    }
    current.lines.push(line)
  }
  const tasks = doc.sections.find(s => /^tasks$/i.test(s.title))
  const log = doc.sections.find(s => /^log$/i.test(s.title))
  let next = 1 + Math.max(0, ...(tasks?.lines ?? []).map(l => Number(/\(T(\d+)\)/.exec(l)?.[1] ?? 0)))
  for (const line of tasks?.lines ?? []) {
    const m = LINE.exec(line)
    const text = m?.[3]?.trim() ?? ''
    if (!m || text === '') continue
    doc.tasks.push({
      id: m[2] ?? `T${next++}`,
      state: STATE[m[1] ?? ' '] ?? 'open',
      text,
      owner: m[4],
      note: m[5]?.trim() || undefined,
    })
  }
  doc.log = (log?.lines ?? []).filter(l => l.trim() !== '')

  return doc
}

export function serialize(doc: HandoverDoc): string {
  const taskLines = doc.tasks.map(t => {
    const tail = t.owner ? ` — @${t.owner}${t.note ? `: ${t.note}` : ''}` : ''

    return `- [${MARK[t.state]}] (${t.id}) ${t.text}${tail}`
  })
  const sections = doc.sections.some(s => /^tasks$/i.test(s.title))
    ? doc.sections
    : [{ title: 'Tasks', lines: [] }, ...doc.sections]
  const withLog = sections.some(s => /^log$/i.test(s.title))
    ? sections
    : [...sections, { title: 'Log', lines: [] }]
  const body = withLog.map(s => {
    if (/^tasks$/i.test(s.title)) return `## ${s.title}\n\n${taskLines.join('\n')}\n`
    if (/^log$/i.test(s.title)) return `## ${s.title}\n\n${doc.log.slice(-60).join('\n')}\n`

    return `## ${s.title}\n${s.lines.join('\n').replace(/\n+$/, '')}\n`
  })

  return `${doc.head.join('\n').replace(/\n+$/, '')}\n\n${body.join('\n')}`
}
