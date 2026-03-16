import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ConnectionSettingsStore,
  DesktopConnectionSettings,
} from './types.js'

interface SafeStorageLike {
  decryptString(value: Buffer): string
  encryptString(value: string): Buffer
  isEncryptionAvailable(): boolean
}

interface StoredConnectionEnvelope {
  kind: 'plain-text' | 'safe-storage'
  payload: string
  version: 1
}

export interface FileConnectionSettingsStoreOptions {
  filePath: string
  safeStorage?: SafeStorageLike
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function validateConnectionSettings(value: unknown) {
  const record =
    typeof value === 'object' && value !== null
      ? (value as Partial<DesktopConnectionSettings>)
      : undefined

  if (
    typeof record?.baseUrl !== 'string' ||
    record.baseUrl.trim().length === 0 ||
    typeof record.token !== 'string' ||
    record.token.trim().length === 0
  ) {
    throw new Error('Stored desktop connection settings are invalid.')
  }

  return {
    baseUrl: record.baseUrl.trim().replace(/\/+$/, ''),
    token: record.token.trim(),
  } satisfies DesktopConnectionSettings
}

function serializeConnectionEnvelope(
  settings: DesktopConnectionSettings,
  safeStorage?: SafeStorageLike,
) {
  const payload = JSON.stringify(settings)
  if (safeStorage?.isEncryptionAvailable()) {
    return {
      kind: 'safe-storage',
      payload: safeStorage.encryptString(payload).toString('base64'),
      version: 1,
    } satisfies StoredConnectionEnvelope
  }

  return {
    kind: 'plain-text',
    payload: Buffer.from(payload, 'utf8').toString('base64'),
    version: 1,
  } satisfies StoredConnectionEnvelope
}

function deserializeConnectionEnvelope(
  envelope: StoredConnectionEnvelope,
  safeStorage?: SafeStorageLike,
) {
  if (envelope.kind === 'safe-storage') {
    if (!safeStorage) {
      throw new Error('Electron safeStorage is required to read encrypted desktop settings.')
    }

    return safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'))
  }

  return Buffer.from(envelope.payload, 'base64').toString('utf8')
}

export function createFileConnectionSettingsStore(
  options: FileConnectionSettingsStoreOptions,
): ConnectionSettingsStore {
  return {
    async clear() {
      try {
        await rm(options.filePath)
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error
        }
      }
    },
    async load() {
      try {
        const raw = await readFile(options.filePath, 'utf8')
        const envelope = JSON.parse(raw) as StoredConnectionEnvelope
        const payload = deserializeConnectionEnvelope(
          envelope,
          options.safeStorage,
        )
        return validateConnectionSettings(JSON.parse(payload))
      } catch (error) {
        if (isMissingFileError(error)) {
          return null
        }

        throw error
      }
    },
    async save(settings) {
      const normalizedSettings = validateConnectionSettings(settings)
      const envelope = serializeConnectionEnvelope(
        normalizedSettings,
        options.safeStorage,
      )

      await mkdir(dirname(options.filePath), { recursive: true })
      await writeFile(
        options.filePath,
        JSON.stringify(envelope, null, 2),
        {
          encoding: 'utf8',
          mode: 0o600,
        },
      )
    },
  }
}

export function createMemoryConnectionSettingsStore(
  initialValue: DesktopConnectionSettings | null = null,
): ConnectionSettingsStore {
  let currentValue = initialValue

  return {
    async clear() {
      currentValue = null
    },
    async load() {
      return currentValue
    },
    async save(settings) {
      currentValue = validateConnectionSettings(settings)
    },
  }
}

