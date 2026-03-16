import assert from 'node:assert/strict'
import test from 'node:test'
import { startControlPlaneHttpServer, type ControlPlaneEvent } from '../../../apps/server/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

const viewerHeaders = {
  authorization: 'Bearer control-plane-viewer',
}

// eslint-disable-next-line no-unused-vars
type EventPredicate = (event: ControlPlaneEvent) => boolean

test('US-007 starts reconnectable coding agent sessions and streams live lifecycle, log, and output events', async () => {
  const handle = await startControlPlaneHttpServer()

  try {
    await postCreatedJson(handle.origin, '/v1/hosts', {
      id: 'host_build',
      label: 'Build Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })
    await postCreatedJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_app',
      hostId: 'host_build',
      name: 'Application Workspace',
      repositoryPath: process.cwd(),
    })

    const sessionCreatedEvent = prepareEventRead(
      handle.origin,
      'session.upserted',
      (event) => (event.payload as { session: { id: string } }).session.id === 'session_build',
    )
    const sessionStartedEvent = prepareEventRead(handle.origin, 'session.event.created', (event) => {
      const sessionEvent = (event.payload as { sessionEvent: { sessionId: string; kind: string; status?: string } }).sessionEvent
      return sessionEvent.sessionId === 'session_build' && sessionEvent.kind === 'status' && sessionEvent.status === 'running'
    })
    await Promise.all([sessionCreatedEvent.ready, sessionStartedEvent.ready])

    const createdSession = await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_build',
      hostId: 'host_build',
      workspaceId: 'workspace_app',
      provider: 'codex',
    })

    assert.equal(createdSession.data.id, 'session_build')
    assert.equal(createdSession.data.workspaceId, 'workspace_app')
    assert.equal(createdSession.data.provider, 'codex')
    assert.equal(createdSession.data.status, 'running')
    await sessionCreatedEvent.result
    await sessionStartedEvent.result

    const logEvent = prepareEventRead(handle.origin, 'session.event.created', (event) => {
      const sessionEvent = (event.payload as { sessionEvent: { sessionId: string; kind: string; message: string } }).sessionEvent
      return sessionEvent.sessionId === 'session_build' && sessionEvent.kind === 'log' && sessionEvent.message === 'Installing dependencies'
    })
    const outputEvent = prepareEventRead(handle.origin, 'session.event.created', (event) => {
      const sessionEvent = (event.payload as { sessionEvent: { sessionId: string; kind: string; message: string; stream?: string } }).sessionEvent
      return sessionEvent.sessionId === 'session_build' && sessionEvent.kind === 'output' && sessionEvent.stream === 'stdout'
    })
    await Promise.all([logEvent.ready, outputEvent.ready])

    await postCreatedJson(handle.origin, '/v1/sessions/session_build/events', {
      kind: 'log',
      level: 'info',
      message: 'Installing dependencies',
    })
    await postCreatedJson(handle.origin, '/v1/sessions/session_build/events', {
      kind: 'output',
      stream: 'stdout',
      message: 'pnpm install',
    })

    await logEvent.result
    await outputEvent.result

    const pausedUpdate = prepareEventRead(handle.origin, 'session.updated', (event) => {
      const session = (event.payload as { session: { id: string; status: string } }).session
      return session.id === 'session_build' && session.status === 'paused'
    })
    const pausedStatusEvent = prepareEventRead(handle.origin, 'session.event.created', (event) => {
      const sessionEvent = (event.payload as { sessionEvent: { sessionId: string; kind: string; status?: string } }).sessionEvent
      return sessionEvent.sessionId === 'session_build' && sessionEvent.kind === 'status' && sessionEvent.status === 'paused'
    })
    await Promise.all([pausedUpdate.ready, pausedStatusEvent.ready])
    const pausedSession = await postOkJson(handle.origin, '/v1/sessions/session_build/actions', {
      action: 'pause',
    })

    assert.equal(pausedSession.data.status, 'paused')
    await pausedUpdate.result
    await pausedStatusEvent.result

    const resumedUpdate = prepareEventRead(handle.origin, 'session.updated', (event) => {
      const session = (event.payload as { session: { id: string; status: string } }).session
      return session.id === 'session_build' && session.status === 'running'
    })
    const resumedStatusEvent = prepareEventRead(handle.origin, 'session.event.created', (event) => {
      const sessionEvent = (event.payload as { sessionEvent: { sessionId: string; kind: string; status?: string } }).sessionEvent
      return sessionEvent.sessionId === 'session_build' && sessionEvent.kind === 'status' && sessionEvent.status === 'running'
    })
    await Promise.all([resumedUpdate.ready, resumedStatusEvent.ready])
    const resumedSession = await postOkJson(handle.origin, '/v1/sessions/session_build/actions', {
      action: 'resume',
    })

    assert.equal(resumedSession.data.status, 'running')
    await resumedUpdate.result
    await resumedStatusEvent.result

    const sessionDetail = await getJson(handle.origin, '/v1/sessions/session_build')
    assert.equal(sessionDetail.data.id, 'session_build')
    assert.equal(sessionDetail.data.status, 'running')

    const sessionHistory = await getJson(handle.origin, '/v1/sessions/session_build/events')
    assert.equal(sessionHistory.data.length, 5)
    assert.deepEqual(
      sessionHistory.data.map((entry: { sequence: number }) => entry.sequence),
      [1, 2, 3, 4, 5],
    )
    assert.deepEqual(
      sessionHistory.data.map((entry: { kind: string }) => entry.kind),
      ['status', 'log', 'output', 'status', 'status'],
    )

    const reconnectSnapshot = await readEvent(handle.origin, 'control-plane.snapshot', (event) => {
      const payload = event.payload as {
        sessions: Array<{ id: string; status: string }>
        sessionEvents: Array<{ sessionId: string; kind: string }>
      }

      return (
        payload.sessions.some((session) => session.id === 'session_build' && session.status === 'running') &&
        payload.sessionEvents.filter((sessionEvent) => sessionEvent.sessionId === 'session_build').length === 5
      )
    })
    const reconnectPayload = reconnectSnapshot.payload as {
      sessions: Array<{ id: string; status: string }>
      sessionEvents: Array<{ sessionId: string; message: string }>
    }
    assert.ok(reconnectPayload.sessions.some((session) => session.id === 'session_build' && session.status === 'running'))
    assert.ok(
      reconnectPayload.sessionEvents.some(
        (sessionEvent) => sessionEvent.sessionId === 'session_build' && sessionEvent.message === 'Installing dependencies',
      ),
    )

    const canceledUpdate = prepareEventRead(handle.origin, 'session.updated', (event) => {
      const session = (event.payload as { session: { id: string; status: string } }).session
      return session.id === 'session_build' && session.status === 'canceled'
    })
    await canceledUpdate.ready
    const canceledSession = await postOkJson(handle.origin, '/v1/sessions/session_build/actions', {
      action: 'cancel',
    })

    assert.equal(canceledSession.data.status, 'canceled')
    await canceledUpdate.result
  } finally {
    await handle.close()
  }
})

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

async function postOkJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 200)
  return (await response.json()) as { data: any }
}

async function readEvent(origin: string, expectedType: string, predicate?: EventPredicate) {
  return prepareEventRead(origin, expectedType, predicate).result
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
