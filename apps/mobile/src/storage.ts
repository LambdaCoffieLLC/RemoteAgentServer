import type { ConnectionSettingsStore, MobileConnectionSettings } from './types.js'

export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string): Promise<void>
  deleteItemAsync(key: string): Promise<void>
}

const connectionSettingsKey = 'remote-agent-server.mobile.connection'

function parseStoredConnectionSettings(value: string | null) {
  if (!value) {
    return null
  }

  const parsed = JSON.parse(value) as Partial<MobileConnectionSettings>
  if (typeof parsed.baseUrl !== 'string' || typeof parsed.token !== 'string') {
    throw new Error('Stored mobile connection settings are invalid.')
  }

  return {
    baseUrl: parsed.baseUrl,
    token: parsed.token,
  } satisfies MobileConnectionSettings
}

export function createSecureConnectionSettingsStore(
  secureStore: SecureStoreLike,
): ConnectionSettingsStore {
  return {
    async load() {
      return parseStoredConnectionSettings(
        await secureStore.getItemAsync(connectionSettingsKey),
      )
    },
    async save(settings) {
      await secureStore.setItemAsync(connectionSettingsKey, JSON.stringify(settings))
    },
    async clear() {
      await secureStore.deleteItemAsync(connectionSettingsKey)
    },
  }
}

export function createMemoryConnectionSettingsStore(
  initialSettings?: MobileConnectionSettings,
): ConnectionSettingsStore {
  let currentValue = initialSettings ? JSON.stringify(initialSettings) : null

  return {
    async load() {
      return parseStoredConnectionSettings(currentValue)
    },
    async save(settings) {
      currentValue = JSON.stringify(settings)
    },
    async clear() {
      currentValue = null
    },
  }
}
