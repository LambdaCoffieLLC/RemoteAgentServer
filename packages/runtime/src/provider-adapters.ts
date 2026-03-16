import { type ProviderKind } from '@remote-agent-server/providers'
import {
  type SessionLogLevel,
  type SessionMode,
  type SessionOutputStream,
} from '@remote-agent-server/sessions'

type ScriptedRuntimeProviderStep =
  | { kind: 'log'; level: SessionLogLevel; message: string }
  | { kind: 'output'; stream: SessionOutputStream; text: string }

export interface RuntimeProviderLaunchRequest {
  sessionId: string
  workspaceId: string
  workspacePath: string
  provider: ProviderKind
  mode: SessionMode
}

export interface RuntimeProviderExit {
  code: number
  detail?: string
}

export type RuntimeProviderFailureMode =
  | { phase: 'launch'; message: string }
  | { phase: 'runtime'; message: string; afterSteps?: number }

export interface RuntimeProviderObserver {
  onLog(level: SessionLogLevel, message: string): void
  onOutput(stream: SessionOutputStream, text: string): void
  onExit(result: RuntimeProviderExit): void
  onFailure(error: Error): void
}

export interface RuntimeProviderProcess {
  pause(): void
  resume(): void
  cancel(): void
  dispose(): void
}

export interface RuntimeProviderAdapter {
  readonly kind: ProviderKind
  launch(request: RuntimeProviderLaunchRequest, observer: RuntimeProviderObserver): RuntimeProviderProcess
}

export interface RuntimeProviderAdapterRegistry {
  getAdapter(kind: ProviderKind): RuntimeProviderAdapter | undefined
  listAdapters(): RuntimeProviderAdapter[]
}

export interface ScriptedRuntimeProviderAdapterOptions {
  failure?: RuntimeProviderFailureMode
  stepDelayMs?: number
}

interface ScriptedRuntimeProviderDefinition {
  kind: ProviderKind
  steps: ScriptedRuntimeProviderStep[]
  successDetail: string
}

const defaultStepDelayMs = 40

const scriptedProviderDefinitions: Record<ProviderKind, ScriptedRuntimeProviderDefinition> = {
  'claude-code': {
    kind: 'claude-code',
    steps: [
      { kind: 'log', level: 'info', message: 'Collecting repository context.' },
      { kind: 'output', stream: 'stdout', text: 'claude> reading workspace files\n' },
      { kind: 'log', level: 'info', message: 'Drafting an implementation plan.' },
      { kind: 'output', stream: 'stdout', text: 'claude> plan ready for execution\n' },
      { kind: 'log', level: 'info', message: 'Applying the requested changes.' },
    ],
    successDetail: 'Claude Code completed the session successfully.',
  },
  codex: {
    kind: 'codex',
    steps: [
      { kind: 'log', level: 'info', message: 'Inspecting the workspace before changes.' },
      { kind: 'output', stream: 'stdout', text: 'codex> rg --files\n' },
      { kind: 'log', level: 'info', message: 'Implementing the active user story.' },
      { kind: 'output', stream: 'stdout', text: 'codex> apply_patch\n' },
      { kind: 'log', level: 'info', message: 'Running verification for the session changes.' },
    ],
    successDetail: 'Codex completed the session successfully.',
  },
  opencode: {
    kind: 'opencode',
    steps: [
      { kind: 'log', level: 'info', message: 'Indexing the workspace.' },
      { kind: 'output', stream: 'stdout', text: 'opencode> workspace indexed\n' },
      { kind: 'log', level: 'info', message: 'Producing code changes.' },
      { kind: 'output', stream: 'stdout', text: 'opencode> patch generated\n' },
      { kind: 'log', level: 'info', message: 'Preparing a completion summary.' },
    ],
    successDetail: 'OpenCode completed the session successfully.',
  },
}

class ScriptedRuntimeProviderProcess implements RuntimeProviderProcess {
  private readonly stepDelayMs: number
  private readonly failure?: RuntimeProviderFailureMode

  private emittedSteps = 0
  private nextStepIndex = 0
  private paused = false
  private stopped = false
  private timeout?: NodeJS.Timeout

  constructor(
    private readonly definition: ScriptedRuntimeProviderDefinition,
    private readonly observer: RuntimeProviderObserver,
    options: ScriptedRuntimeProviderAdapterOptions,
  ) {
    this.stepDelayMs = options.stepDelayMs ?? defaultStepDelayMs
    this.failure = options.failure
    this.scheduleNextStep()
  }

  pause() {
    if (this.stopped) {
      return
    }

    this.paused = true
    this.clearTimeout()
  }

  resume() {
    if (this.stopped || !this.paused) {
      return
    }

    this.paused = false
    this.scheduleNextStep()
  }

  cancel() {
    this.stop()
  }

  dispose() {
    this.stop()
  }

  private stop() {
    this.stopped = true
    this.paused = false
    this.clearTimeout()
  }

  private scheduleNextStep() {
    if (this.stopped || this.paused) {
      return
    }

    this.timeout = setTimeout(() => {
      this.timeout = undefined

      if (this.stopped || this.paused) {
        return
      }

      const step = this.definition.steps[this.nextStepIndex]
      if (!step) {
        this.stop()
        this.observer.onExit({
          code: 0,
          detail: this.definition.successDetail,
        })
        return
      }

      this.nextStepIndex += 1
      this.emittedSteps += 1

      if (step.kind === 'log') {
        this.observer.onLog(step.level, step.message)
      } else {
        this.observer.onOutput(step.stream, step.text)
      }

      if (this.failure?.phase === 'runtime' && this.emittedSteps >= (this.failure.afterSteps ?? 0)) {
        this.stop()
        this.observer.onFailure(new Error(this.failure.message))
        return
      }

      this.scheduleNextStep()
    }, this.stepDelayMs)
  }

  private clearTimeout() {
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = undefined
    }
  }
}

function createScriptedRuntimeProviderAdapter(
  definition: ScriptedRuntimeProviderDefinition,
  options: ScriptedRuntimeProviderAdapterOptions = {},
): RuntimeProviderAdapter {
  return {
    kind: definition.kind,
    launch(_request, observer) {
      if (options.failure?.phase === 'launch') {
        throw new Error(options.failure.message)
      }

      return new ScriptedRuntimeProviderProcess(definition, observer, options)
    },
  }
}

export function createClaudeCodeProviderAdapter(options?: ScriptedRuntimeProviderAdapterOptions): RuntimeProviderAdapter {
  return createScriptedRuntimeProviderAdapter(scriptedProviderDefinitions['claude-code'], options)
}

export function createCodexProviderAdapter(options?: ScriptedRuntimeProviderAdapterOptions): RuntimeProviderAdapter {
  return createScriptedRuntimeProviderAdapter(scriptedProviderDefinitions.codex, options)
}

export function createOpenCodeProviderAdapter(options?: ScriptedRuntimeProviderAdapterOptions): RuntimeProviderAdapter {
  return createScriptedRuntimeProviderAdapter(scriptedProviderDefinitions.opencode, options)
}

export function createDefaultRuntimeProviderAdapters(): RuntimeProviderAdapter[] {
  return [
    createClaudeCodeProviderAdapter(),
    createCodexProviderAdapter(),
    createOpenCodeProviderAdapter(),
  ]
}

export function createRuntimeProviderAdapterRegistry(
  adapters: Iterable<RuntimeProviderAdapter> = createDefaultRuntimeProviderAdapters(),
): RuntimeProviderAdapterRegistry {
  const adapterMap = new Map<ProviderKind, RuntimeProviderAdapter>()

  for (const adapter of adapters) {
    if (adapterMap.has(adapter.kind)) {
      throw new Error(`Runtime provider adapter "${adapter.kind}" is already registered.`)
    }

    adapterMap.set(adapter.kind, adapter)
  }

  return {
    getAdapter(kind) {
      return adapterMap.get(kind)
    },
    listAdapters() {
      return [...adapterMap.values()]
    },
  }
}
