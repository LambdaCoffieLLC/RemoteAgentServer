import type { ForwardedPortRecord, PreviewOpenMode, PreviewOpener } from './types.js'

export interface PreviewBrowserAdapter {
  openBrowserAsync(url: string): Promise<unknown>
  openUrl(url: string): Promise<unknown>
}

function requireManagedPreviewUrl(port: ForwardedPortRecord) {
  if (port.protocol !== 'http' || !port.managedUrl) {
    throw new Error(`Port "${port.id}" does not expose an HTTP preview URL.`)
  }

  return port.managedUrl
}

export function createPreviewOpener(adapter: PreviewBrowserAdapter): PreviewOpener {
  return {
    async open(port, mode) {
      const previewUrl = requireManagedPreviewUrl(port)
      await openPreviewUrl(adapter, previewUrl, mode)
    },
  }
}

export async function openPreviewUrl(
  adapter: PreviewBrowserAdapter,
  previewUrl: string,
  mode: PreviewOpenMode,
) {
  if (mode === 'in-app') {
    await adapter.openBrowserAsync(previewUrl)
    return
  }

  await adapter.openUrl(previewUrl)
}
