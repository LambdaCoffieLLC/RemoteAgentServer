import type { SecureStoreLike } from './storage.js'
import { createSecureConnectionSettingsStore } from './storage.js'

export function createExpoConnectionSettingsStore(secureStore: SecureStoreLike) {
  return createSecureConnectionSettingsStore(secureStore)
}
