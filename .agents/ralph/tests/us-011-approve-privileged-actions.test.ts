import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  RuntimeSessionManager,
  createProviderAdapterRegistry,
  type ProviderAdapter,
} from '../../../apps/runtime/src/index.js'
import { startControlPlaneHttpServer, type ControlPlaneEvent } from '../../../apps/server/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

const viewerHeaders = {
  authorization: 'Bearer control-plane-viewer',
}

test('US-011 lets providers raise privileged actions through a shared approval interface', async () => {
  const manager = new RuntimeSessionManager({
    providerRegistry: createProviderAdapterRegistry([
      createApprovalAwareProviderAdapter({
        approvalId: 'approval_runtime_privileged',
        action: 'Run sudo apt update',
        reason: 'The provider needs root access to refresh system packages.',
      }),
    ]),
    approvalHandler: (approval) => ({
      status: 'approved',
      decidedBy: {
        id: 'user_reviewer',
        displayName: 'Reviewer',
      },
      message: `Approval granted for ${approval.action}.`,
    }),
  })

  const result = await manager.startSession({
    id: 'session_runtime_privileged',
    hostId: 'host_runtime',
    workspaceId: 'workspace_runtime',
    workspacePath: process.cwd(),
    provider: 'codex',
    prompt: 'Refresh packages safely.',
  })

  assert.equal(result.session.status, 'completed')
  assert.equal(result.approvals.length, 1)
  assert.equal(result.approvals[0]?.approvalId, 'approval_runtime_privileged')
  assert.equal(result.approvals[0]?.status, 'approved')
  assert.equal(result.approvals[0]?.decidedBy?.id, 'user_reviewer')
  assert.ok(result.events.some((event) => event.kind === 'log' && event.message.includes('Approval required for Run sudo apt update')))
  assert.ok(result.events.some((event) => event.kind === 'log' && event.message === 'Approval granted for Run sudo apt update.'))
  assert.equal(result.events.at(-1)?.status, 'completed')
})

test('US-011 surfaces rejected privileged actions cleanly to the running session', async () => {
  const manager = new RuntimeSessionManager({
    providerRegistry: createProviderAdapterRegistry([
      createApprovalAwareProviderAdapter({
        approvalId: 'approval_runtime_rejected',
        action: 'Delete protected branch',
      }),
    ]),
    approvalHandler: () => ({
      status: 'rejected',
      decidedBy: {
        id: 'user_reviewer',
        displayName: 'Reviewer',
      },
      message: 'Rejected by reviewer.',
    }),
  })

  const result = await manager.startSession({
    id: 'session_runtime_rejected',
    hostId: 'host_runtime',
    workspaceId: 'workspace_runtime',
    workspacePath: process.cwd(),
    provider: 'codex',
    prompt: 'Try the protected action.',
  })

  assert.equal(result.session.status, 'failed')
  assert.equal(result.approvals.length, 1)
  assert.equal(result.approvals[0]?.status, 'rejected')
  assert.equal(result.approvals[0]?.decidedBy?.id, 'user_reviewer')
  assert.equal(result.failure?.message, 'Rejected by reviewer.')
  assert.ok(result.events.some((event) => event.kind === 'log' && event.message === 'Rejected by reviewer.'))
  assert.equal(result.events.at(-1)?.status, 'failed')
  assert.equal(result.events.at(-1)?.message, 'Session failed because a privileged action was rejected.')
})

test('US-011 lets clients approve or reject pending actions and stores an approval audit trail', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-011-'))
  const storagePath = join(tempDir, 'control-plane-state.json')

  let handle: Awaited<ReturnType<typeof startControlPlaneHttpServer>> | undefined = await startControlPlaneHttpServer({ storagePath })

  try {
    await postCreatedJson(handle.origin, '/v1/hosts', {
      id: 'host_guarded',
      label: 'Guarded Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })
    await postCreatedJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_guarded',
      hostId: 'host_guarded',
      name: 'Guarded Workspace',
      repositoryPath: process.cwd(),
    })
    await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_guarded',
      hostId: 'host_guarded',
      workspaceId: 'workspace_guarded',
      provider: 'codex',
    })

    const rejectionEvent = prepareEventRead(handle.origin, 'session.event.created', (event) => {
      const sessionEvent = (event.payload as { sessionEvent: { sessionId: string; kind: string; message: string } }).sessionEvent
      return (
        sessionEvent.sessionId === 'session_guarded' &&
        sessionEvent.kind === 'log' &&
        sessionEvent.message === 'Privileged action rejected: Delete deployment namespace.'
      )
    })
    await rejectionEvent.ready

    await postCreatedJson(handle.origin, '/v1/approvals', {
      id: 'approval_restart',
      sessionId: 'session_guarded',
      action: 'Restart production preview',
    })
    await postCreatedJson(handle.origin, '/v1/approvals', {
      id: 'approval_delete',
      sessionId: 'session_guarded',
      action: 'Delete deployment namespace',
    })

    const pendingApprovals = await getJson(handle.origin, '/v1/approvals')
    assert.deepEqual(
      pendingApprovals.data.map((approval: { status: string }) => approval.status).sort(),
      ['pending', 'pending'],
    )

    const approved = await patchJson(handle.origin, '/v1/approvals/approval_restart', {
      status: 'approved',
    })
    const rejected = await patchJson(handle.origin, '/v1/approvals/approval_delete', {
      status: 'rejected',
    })

    assert.equal(approved.data.status, 'approved')
    assert.equal(rejected.data.status, 'rejected')
    await rejectionEvent.result

    const approvalList = await getJson(handle.origin, '/v1/approvals')
    assert.deepEqual(
      approvalList.data
        .map((approval: { id: string; status: string }) => `${approval.id}:${approval.status}`)
        .sort(),
      ['approval_delete:rejected', 'approval_restart:approved'],
    )

    const sessionHistory = await getJson(handle.origin, '/v1/sessions/session_guarded/events')
    assert.ok(
      sessionHistory.data.some(
        (event: { kind: string; message: string }) =>
          event.kind === 'log' && event.message === 'Privileged action rejected: Delete deployment namespace.',
      ),
    )

    const auditLog = handle.controlPlane.snapshot().auditLog
    assert.deepEqual(
      auditLog.map((entry) => `${entry.action}:${entry.targetId}:${entry.outcome}`).sort(),
      [
        'approval.approved:approval_restart:approved',
        'approval.rejected:approval_delete:rejected',
        'approval.requested:approval_delete:requested',
        'approval.requested:approval_restart:requested',
      ],
    )
    assert.ok(auditLog.every((entry) => entry.actor.id === 'user_operator'))

    await handle.close()
    handle = undefined
    handle = await startControlPlaneHttpServer({ storagePath })

    const persistedAuditLog = handle.controlPlane.snapshot().auditLog
    assert.equal(persistedAuditLog.length, 4)
    assert.ok(
      persistedAuditLog.some(
        (entry) => entry.action === 'approval.rejected' && entry.targetId === 'approval_delete' && entry.outcome === 'rejected',
      ),
    )
  } finally {
    if (handle) {
      await handle.close()
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})

// eslint-disable-next-line no-unused-vars
type EventPredicate = (event: ControlPlaneEvent) => boolean

function createApprovalAwareProviderAdapter(input: {
  approvalId: `approval_${string}`
  action: string
  reason?: string
}): ProviderAdapter {
  return {
    descriptor: {
      id: 'codex',
      displayName: 'Codex',
      capabilities: ['logs', 'notifications', 'approvals'],
    },
    async launchSession(request) {
      return {
        command: {
          command: process.execPath,
          args: ['--input-type=module', '-e', 'process.exit(0)'],
          cwd: request.workspacePath,
        },
        monitor: async (runtime) => {
          void runtime
          await request.requestApproval?.({
            approvalId: input.approvalId,
            action: input.action,
            reason: input.reason,
          })

          return [
            {
              kind: 'output',
              stream: 'stdout',
              message: `privileged:${input.action}`,
            },
            {
              kind: 'status',
              status: 'completed',
              message: 'Privileged action completed after approval.',
            },
          ]
        },
      }
    },
  }
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`, {
    headers: viewerHeaders,
  })

  assert.equal(response.status, 200)
  return (await response.json()) as { data: any }
}

async function postCreatedJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 201)
  return (await response.json()) as { data: any }
}

async function patchJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'PATCH',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 200)
  return (await response.json()) as { data: any }
}

function prepareEventRead(origin: string, expectedType: string, predicate?: EventPredicate) {
  const controller = new AbortController()
  let markReady: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  const result = (async () => {
    const response = await fetch(`${origin}/v1/events`, {
      headers: viewerHeaders,
      signal: controller.signal,
    })

    assert.equal(response.status, 200)
    assert.ok(response.body)
    markReady()

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })

        while (buffer.includes('\n\n')) {
          const boundary = buffer.indexOf('\n\n')
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)

          const event = parseSseFrame(frame)

          if (event?.type === expectedType && (!predicate || predicate(event))) {
            return event
          }
        }
      }
    } finally {
      controller.abort()

      try {
        await reader.cancel()
      } catch {
        // The abort closes the stream before cancel completes.
      }
    }

    throw new Error(`Expected to receive ${expectedType} from the control-plane event stream.`)
  })()

  return {
    ready,
    result,
  }
}

function parseSseFrame(frame: string): ControlPlaneEvent | undefined {
  const eventName = frame
    .split('\n')
    .find((line) => line.startsWith('event:'))
    ?.slice('event:'.length)
    .trim()
  const data = frame
    .split('\n')
    .find((line) => line.startsWith('data:'))
    ?.slice('data:'.length)
    .trim()

  if (!eventName || !data) {
    return undefined
  }

  return JSON.parse(data) as ControlPlaneEvent
}
