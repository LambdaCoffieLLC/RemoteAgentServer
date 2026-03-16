import EventSourceModule, { type EventSourceListener } from 'react-native-sse'
import type { EventConnector } from './client.js'
import type { ControlPlaneEventRecord } from './types.js'

interface EventSourceConstructor {
  new (
    url: string,
    options?: {
      headers?: Record<string, unknown>
      pollingInterval?: number
      timeout?: number
    },
  ): {
    addEventListener(type: string, listener: EventSourceListener): void
    removeAllEventListeners(type?: string): void
    close(): void
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '')
}

function parseMessageEvent(data: string | null) {
  if (!data) {
    return undefined
  }

  return JSON.parse(data) as ControlPlaneEventRecord
}

export function createReactNativeSseConnector(): EventConnector {
  return {
    connect(settings, listener, lastEventId) {
      let closeRequested = false
      let settled = false
      let resolveDone: (() => void) | undefined
      let rejectDone: ((error: Error) => void) | undefined
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve
        rejectDone = reject
      })
      const EventSource = EventSourceModule as unknown as EventSourceConstructor

      function settleResolve() {
        if (settled) {
          return
        }

        settled = true
        resolveDone?.()
      }

      function settleReject(error: Error) {
        if (settled) {
          return
        }

        settled = true
        rejectDone?.(error)
      }

      const eventSource = new EventSource(
        `${normalizeBaseUrl(settings.baseUrl)}/api/events`,
        {
          headers: {
            Authorization: {
              toString() {
                return `Bearer ${settings.token}`
              },
            },
            ...(lastEventId
              ? {
                  'Last-Event-ID': {
                    toString() {
                      return lastEventId
                    },
                  },
                }
              : {}),
          },
          pollingInterval: 5000,
          timeout: 0,
        },
      )

      const messageListener: EventSourceListener = (event) => {
        if (event.type !== 'message') {
          return
        }

        const parsed = parseMessageEvent(event.data)
        if (parsed) {
          listener(parsed)
        }
      }
      const openListener: EventSourceListener = (event) => {
        if (event.type === 'open') {
          settled = false
        }
      }
      const errorListener: EventSourceListener = (event) => {
        if (closeRequested) {
          settleResolve()
          return
        }

        if (event.type === 'error' || event.type === 'exception') {
          settleReject(new Error(event.message))
          return
        }

        settleReject(new Error('Live updates disconnected.'))
      }
      const closeListener: EventSourceListener = (event) => {
        if (event.type === 'close') {
          settleResolve()
        }
      }

      eventSource.addEventListener('open', openListener)
      eventSource.addEventListener('message', messageListener)
      eventSource.addEventListener('error', errorListener)
      eventSource.addEventListener('close', closeListener)

      return {
        close() {
          closeRequested = true
          eventSource.removeAllEventListeners()
          eventSource.close()
        },
        done,
      }
    },
  }
}
