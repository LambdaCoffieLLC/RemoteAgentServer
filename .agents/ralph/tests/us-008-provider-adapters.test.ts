import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RuntimeSessionManager,
  createProviderAdapterRegistry,
  createRuntimeProviderRegistry,
  type CoreProviderCommandTemplate,
} from '../../../apps/runtime/src/index.js'

test('US-008 exposes a common provider adapter interface for Claude Code, Codex, and OpenCode', async () => {
  const providerRegistry = createRuntimeProviderRegistry({
    commands: {
      'claude-code': createNodeCommandTemplate('claude-code'),
      codex: createNodeCommandTemplate('codex'),
      opencode: createNodeCommandTemplate('opencode'),
    },
  })
  const adapterRegistry = createProviderAdapterRegistry(providerRegistry.list())

  assert.equal(adapterRegistry.list().length, 3)
  assert.ok(adapterRegistry.get('claude-code'))
  assert.ok(adapterRegistry.get('codex'))
  assert.ok(adapterRegistry.get('opencode'))

  const manager = new RuntimeSessionManager({
    providerRegistry,
  })

  for (const provider of ['claude-code', 'codex', 'opencode'] as const) {
    const adapter = adapterRegistry.get(provider)
    assert.ok(adapter)

    const handle = await adapter.launchSession({
      sessionId: `session_handle_${provider}`,
      workspacePath: process.cwd(),
      prompt: `ship ${provider}`,
    })
    assert.equal(handle.command.command, process.execPath)
    assert.equal(typeof handle.monitor, 'function')

    const result = await manager.startSession({
      id: `session_${provider}`,
      hostId: 'host_runtime',
      workspaceId: 'workspace_runtime',
      workspacePath: process.cwd(),
      provider,
      prompt: `ship ${provider}`,
    })

    assert.equal(result.session.provider, provider)
    assert.equal(result.session.status, 'completed')
    assert.equal(result.command?.command, process.execPath)
    assert.deepEqual(
      result.events.map((event) => event.kind),
      ['status', 'output', 'output', 'status'],
    )
    assert.equal(result.events[0]?.status, 'running')
    assert.equal(result.events.at(-1)?.status, 'completed')
    assert.ok(result.events.some((event) => event.stream === 'stdout' && event.message.includes(`stdout:${provider}`)))
    assert.ok(result.events.some((event) => event.stream === 'stderr' && event.message.includes(`stderr:${provider}`)))
  }
})

test('US-008 surfaces provider-specific failures without crashing the runtime session manager', async () => {
  const manager = new RuntimeSessionManager({
    providerRegistry: createRuntimeProviderRegistry({
      commands: {
        'claude-code': createNodeCommandTemplate('claude-code'),
        codex: createNodeCommandTemplate('codex', { exitCode: 7 }),
        opencode: createNodeCommandTemplate('opencode'),
      },
    }),
  })

  const failedCodexSession = await manager.startSession({
    id: 'session_codex_failure',
    hostId: 'host_runtime',
    workspaceId: 'workspace_runtime',
    workspacePath: process.cwd(),
    provider: 'codex',
    prompt: 'ship codex',
  })

  assert.equal(failedCodexSession.session.status, 'failed')
  assert.equal(failedCodexSession.failure, undefined)
  assert.ok(failedCodexSession.events.some((event) => event.kind === 'log' && event.message === 'Codex exited with code 7.'))
  assert.equal(failedCodexSession.events.at(-1)?.status, 'failed')

  const recoveredClaudeSession = await manager.startSession({
    id: 'session_claude_recovered',
    hostId: 'host_runtime',
    workspaceId: 'workspace_runtime',
    workspacePath: process.cwd(),
    provider: 'claude-code',
    prompt: 'ship claude',
  })

  assert.equal(recoveredClaudeSession.session.status, 'completed')
  assert.equal(recoveredClaudeSession.failure, undefined)
})

function createNodeCommandTemplate(provider: string, options: { exitCode?: number } = {}): CoreProviderCommandTemplate {
  return {
    command: process.execPath,
    args(request) {
      const exitCode = options.exitCode ?? 0
      const script = [
        `process.stdout.write(${JSON.stringify(`stdout:${provider}:${request.prompt}\n`)})`,
        `process.stderr.write(${JSON.stringify(`stderr:${provider}:${request.sessionId}\n`)})`,
        `process.exit(${String(exitCode)})`,
      ].join(';')

      return ['--input-type=module', '-e', script]
    },
  }
}
