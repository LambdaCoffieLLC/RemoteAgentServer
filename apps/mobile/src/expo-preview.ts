import type { PreviewBrowserAdapter } from './preview.js'
import { createPreviewOpener } from './preview.js'

export function createExpoPreviewOpener(adapter: PreviewBrowserAdapter) {
  return createPreviewOpener(adapter)
}
