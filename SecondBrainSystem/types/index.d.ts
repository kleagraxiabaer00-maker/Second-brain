export type Tier = 'light' | 'heavy'
export type Role = 'planner' | 'builder' | 'off'

export type Route = { tier: Tier; reason: string; isForced: boolean }

export type Tally = {
  lightTokens: number
  heavyTokens: number
  lightSteps: number
  heavySteps: number
  fallbacks: number
  savedUsd: number
  spentUsd: number
}

export type AgentCard = {
  id: string
  role: Role
  status: string
  task?: string
  updatedAt: number
}

export type BrainEvent = {
  file: string
  kind: 'created' | 'modified' | 'deleted'
  at: number
  delta: string
}

export type TaskState = 'open' | 'claimed' | 'done' | 'failed'

export type HandoverTask = {
  id: string
  state: TaskState
  text: string
  owner?: string
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    SecondBrainSystem: {
      route: Route
      tally: Tally
      allTime: Tally
      role: Role
      agents: AgentCard[]
      tasks: HandoverTask[]
      brain: BrainEvent[]
      builds: Record<string, string>
      theme: string
    }
  }
}
