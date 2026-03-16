import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createDesktopControlPlaneClient,
  deliverDesktopNotification,
  type DesktopClientNotificationRecord,
  type DesktopDeliveredNotification,
} from '../../../apps/desktop/src/index.js'
import { startControlPlaneHttpServer, type ControlPlaneEvent } from '../../../apps/server/src/index.js'
import {
  createMobileControlPlaneClient,
  deliverMobileNotification,
  type MobileDeliveredNotification,
} from '../../../apps/mobile/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

test('US-018 sends opt-in notifications for approvals, failures, and completion with deep links and category controls', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-018-'))
  const storagePath = join(tempDir, 'control-plane-state.json')
  const repositoryPath = join(tempDir, 'repositories', 'notifications-app')

  initializeCommittedGitRepository(repositoryPath)

  const handle = await startControlPlaneHttpServer({ storagePath })

  try {
    await postCreatedJson(handle.origin, '/v1/hosts', {
      id: 'host_notifications',
      label: 'Notification Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })
    await postCreatedJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_notifications',
      hostId: 'host_notifications',
      repositoryPath,
    })
    await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_attention_failed',
      hostId: 'host_notifications',
      workspaceId: 'workspace_notifications',
      provider: 'codex',
      workspaceMode: 'direct',
    })
    await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_attention_completed',
      hostId: 'host_notifications',
      workspaceId: 'workspace_notifications',
      provider: 'codex',
      workspaceMode: 'direct',
    })

    const mobileClient = createMobileControlPlaneClient({
      baseUrl: handle.origin,
      token: 'control-plane-operator',
    })
    const desktopClient = createDesktopControlPlaneClient({
      baseUrl: handle.origin,
      token: 'control-plane-operator',
    })

    const defaultMobilePreferences = await mobileClient.getNotificationPreferences()
    assert.equal(defaultMobilePreferences.client, 'mobile')
    assert.equal(defaultMobilePreferences.enabled, false)
    assert.deepEqual(defaultMobilePreferences.categories, {
      'approval-required': false,
      'session-failed': false,
      'session-completed': false,
      'port-exposed': false,
    })

    const mobilePreferences = await mobileClient.updateNotificationPreferences({
      enabled: true,
      categories: {
        'approval-required': true,
        'session-failed': true,
        'session-completed': false,
      },
    })
    const desktopPreferences = await desktopClient.updateNotificationPreferences({
      enabled: true,
      categories: {
        'approval-required': true,
        'session-failed': false,
        'session-completed': true,
      },
    })

    assert.equal(mobilePreferences.enabled, true)
    assert.equal(mobilePreferences.categories['approval-required'], true)
    assert.equal(mobilePreferences.categories['session-completed'], false)
    assert.equal(desktopPreferences.enabled, true)
    assert.equal(desktopPreferences.categories['session-failed'], false)
    assert.equal(desktopPreferences.categories['session-completed'], true)

    const abortController = new AbortController()
    const iterator = mobileClient.streamEvents({ signal: abortController.signal })[Symbol.asyncIterator]()
    await waitForEvent(iterator, (event) => event.type === 'control-plane.snapshot')

    const approvalNotificationPromise = waitForEvent(
      iterator,
      (event) =>
        event.type === 'notification.created' &&
        (
          event.payload as {
            notification?: {
              category?: string
            }
          }
        ).notification?.category === 'approval-required',
    )
    const failedNotificationPromise = waitForEvent(
      iterator,
      (event) =>
        event.type === 'notification.created' &&
        (
          event.payload as {
            notification?: {
              category?: string
            }
          }
        ).notification?.category === 'session-failed',
    )
    const completedNotificationPromise = waitForEvent(
      iterator,
      (event) =>
        event.type === 'notification.created' &&
        (
          event.payload as {
            notification?: {
              category?: string
            }
          }
        ).notification?.category === 'session-completed',
    )

    await postCreatedJson(handle.origin, '/v1/approvals', {
      id: 'approval_attention',
      sessionId: 'session_attention_failed',
      action: 'Approve database restore',
    })
    await patchJson(handle.origin, '/v1/sessions/session_attention_failed', {
      status: 'failed',
    })
    await patchJson(handle.origin, '/v1/sessions/session_attention_completed', {
      status: 'completed',
    })

    const [approvalEvent, failedEvent, completedEvent] = await Promise.all([
      approvalNotificationPromise,
      failedNotificationPromise,
      completedNotificationPromise,
    ])

    assert.equal(readNotificationCategory(approvalEvent), 'approval-required')
    assert.equal(readNotificationCategory(failedEvent), 'session-failed')
    assert.equal(readNotificationCategory(completedEvent), 'session-completed')

    const notifications = await mobileClient.listNotifications()
    assert.deepEqual(
      notifications.map((notification) => notification.category).sort(),
      ['approval-required', 'session-completed', 'session-failed'],
    )

    const approvalNotification = findNotification(notifications, 'approval-required')
    const failedNotification = findNotification(notifications, 'session-failed')
    const completedNotification = findNotification(notifications, 'session-completed')

    assert.equal(approvalNotification.deepLink, '/sessions/session_attention_failed?approvalId=approval_attention')
    assert.equal(failedNotification.deepLink, '/sessions/session_attention_failed')
    assert.equal(completedNotification.deepLink, '/sessions/session_attention_completed')

    const deliveredMobileNotifications: MobileDeliveredNotification[] = []
    const deliveredDesktopNotifications: DesktopDeliveredNotification[] = []

    for (const notification of notifications) {
      await deliverMobileNotification(notification, mobilePreferences, {
        notify(notificationToDeliver) {
          deliveredMobileNotifications.push(notificationToDeliver)
        },
      })
      await deliverDesktopNotification(notification, desktopPreferences, {
        notify(notificationToDeliver) {
          deliveredDesktopNotifications.push(notificationToDeliver)
        },
      })
    }

    assert.deepEqual(
      deliveredMobileNotifications.map((notification) => notification.category).sort(),
      ['approval-required', 'session-failed'],
    )
    assert.deepEqual(
      deliveredDesktopNotifications.map((notification) => notification.category).sort(),
      ['approval-required', 'session-completed'],
    )
    assert.equal(
      deliveredMobileNotifications.find((notification) => notification.category === 'approval-required')?.deepLink,
      'remote-agent://app/sessions/session_attention_failed?approvalId=approval_attention',
    )
    assert.equal(
      deliveredDesktopNotifications.find((notification) => notification.category === 'session-completed')?.deepLink,
      'remote-agent-desktop://app/sessions/session_attention_completed',
    )

    abortController.abort()
    await iterator.return?.()
  } finally {
    await handle.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

async function waitForEvent(
  iterator: AsyncIterator<ControlPlaneEvent>,
  // eslint-disable-next-line no-unused-vars
  predicate: (event: ControlPlaneEvent) => boolean,
  timeoutMs = 5_000,
) {
  return await new Promise<ControlPlaneEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for a matching notification event.'))
    }, timeoutMs)

    void (async () => {
      try {
        while (true) {
          const next = await iterator.next()

          if (next.done || !next.value) {
            throw new Error('The notification event stream ended before the expected event arrived.')
          }

          if (predicate(next.value)) {
            clearTimeout(timeout)
            resolve(next.value)
            return
          }
        }
      } catch (error) {
        clearTimeout(timeout)
        reject(error)
      }
    })()
  })
}

function readNotificationCategory(event: ControlPlaneEvent) {
  return (
    event.payload as {
      notification?: {
        category?: string
      }
    }
  ).notification?.category
}

function findNotification(notifications: DesktopClientNotificationRecord[], category: DesktopClientNotificationRecord['category']) {
  const notification = notifications.find((entry) => entry.category === category)
  assert.ok(notification)
  return notification
}

function initializeCommittedGitRepository(repositoryPath: string) {
  execFileSync('git', ['init', repositoryPath], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Remote Agent Tests'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'tests@example.com'], { stdio: 'ignore' })
  writeFileSync(join(repositoryPath, 'README.md'), '# notifications app\n', 'utf8')
  execFileSync('git', ['-C', repositoryPath, 'add', 'README.md'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'commit', '-m', 'Initial commit'], { stdio: 'ignore' })
}

async function postCreatedJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 201)
  return (await response.json()) as { data: Record<string, unknown> }
}

async function patchJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'PATCH',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 200)
  return (await response.json()) as { data: Record<string, unknown> }
}
