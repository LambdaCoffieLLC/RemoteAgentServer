import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createClaudeCodeProviderAdapter,
  createCodexProviderAdapter,
  createOpenCodeProviderAdapter,
  createRuntimeSessionManager,
  type RuntimeProviderAdapter,
  type RuntimeSessionEvent,
  type RuntimeSessionHandle,
  type RuntimeSessionSnapshot,
} from '../packages/runtime/src/index.js'

const terminalStates = new Set(['completed', 'failed', 'canceled'])

type ProviderFixture = {
  kind: 'claude-code' | 'codex' | 'opencode'
  expectedOutput: string
  successDetail: string
  createAdapter: typeof createClaudeCodeProviderAdapter
}

const providerFixtures: ProviderFixture[] = [
  {
    kind: 'claude-code',
    expectedOutput: 'claude> reading workspace files',
    successDetail: 'Claude Code completed the session successfully.',
    createAdapter: createClaudeCodeProviderAdapter,
  },
  {
    kind: 'codex',
    expectedOutput: 'codex> rg --files',
    successDetail: 'Codex completed the session successfully.',
    createAdapter: createCodexProviderAdapter,
  },
  {
    kind: 'opencode',
    expectedOutput: 'opencode> workspace indexed',
    successDetail: 'OpenCode completed the session successfully.',
    createAdapter: createOpenCodeProviderAdapter,
  },
]

async function waitForTerminalSession(handle: RuntimeSessionHandle) {
  return await new Promise<{ events: RuntimeSessionEvent[]; snapshot: RuntimeSessionSnapshot }>((resolve, reject) => {
    const events: RuntimeSessionEvent[] = []
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for session "${handle.id}" to reach a terminal state.`))
    }, 5_000)

    const unsubscribe = handle.subscribe((event) => {
      events.push(event)

      if (event.type !== 'session.state.changed') {
        return
      }

      const state = (event.payload as { session: { state: string } }).session.state
      if (!terminalStates.has(state)) {
        return
      }

      clearTimeout(timeout)
      unsubscribe()
      resolve({
        events,
        snapshot: handle.getSnapshot(),
      })
    })
  })
}

function createFailOnceAdapter(
  failingAdapter: RuntimeProviderAdapter,
  healthyAdapter: RuntimeProviderAdapter,
): RuntimeProviderAdapter {
  let launches = 0

  return {
    kind: healthyAdapter.kind,
    launch(request, observer) {
      launches += 1
      return (launches === 1 ? failingAdapter : healthyAdapter).launch(request, observer)
    },
  }
}

for (const fixture of providerFixtures) {
  test(`${fixture.kind} adapter supports launch, output capture, and exit handling`, async () => {
    const manager = createRuntimeSessionManager({
      providerAdapters: [fixture.createAdapter()],
    })

    try {
      const handle = manager.startSession({
        sessionId: `${fixture.kind}-success`,
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/workspace',
        provider: fixture.kind,
      })

      const { events, snapshot } = await waitForTerminalSession(handle)

      assert.equal(snapshot.session.state, 'completed')
      assert.ok(snapshot.startedAt)
      assert.ok(snapshot.completedAt)
      assert.equal(
        snapshot.output.some((entry) => entry.text.includes(fixture.expectedOutput)),
        true,
      )
      assert.equal(
        snapshot.logs.some((entry) => entry.message === fixture.successDetail),
        true,
      )
      assert.equal(
        events.some((event) => event.type === 'session.output'),
        true,
      )
      assert.equal(
        events.some((event) => {
          return event.type === 'session.state.changed' &&
            (event.payload as { session: { state: string } }).session.state === 'completed'
        }),
        true,
      )
      assert.equal(manager.getSession(handle.id), undefined)
    } finally {
      manager.dispose()
    }
  })

  test(`${fixture.kind} adapter reports failures without breaking the runtime session manager`, async () => {
    const failureMessage = `${fixture.kind} provider failed while streaming output.`
    const manager = createRuntimeSessionManager({
      providerAdapters: [
        createFailOnceAdapter(
          fixture.createAdapter({
            failure: {
              phase: 'runtime',
              message: failureMessage,
              afterSteps: 2,
            },
          }),
          fixture.createAdapter(),
        ),
      ],
    })

    try {
      const failedHandle = manager.startSession({
        sessionId: `${fixture.kind}-failure`,
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/workspace',
        provider: fixture.kind,
      })

      const failedSession = await waitForTerminalSession(failedHandle)
      assert.equal(failedSession.snapshot.session.state, 'failed')
      assert.equal(
        failedSession.snapshot.output.some((entry) => entry.text.includes(fixture.expectedOutput)),
        true,
      )
      assert.equal(
        failedSession.snapshot.logs.some((entry) => entry.level === 'error' && entry.message === failureMessage),
        true,
      )
      assert.equal(manager.getSession(failedHandle.id), undefined)

      const recoveredHandle = manager.startSession({
        sessionId: `${fixture.kind}-recovered`,
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/workspace',
        provider: fixture.kind,
      })

      const recoveredSession = await waitForTerminalSession(recoveredHandle)
      assert.equal(recoveredSession.snapshot.session.state, 'completed')
      assert.equal(
        recoveredSession.snapshot.logs.some((entry) => entry.message === fixture.successDetail),
        true,
      )
      assert.equal(manager.getSession(recoveredHandle.id), undefined)
    } finally {
      manager.dispose()
    }
  })
}
