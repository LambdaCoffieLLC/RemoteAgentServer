import { contextBridge, ipcRenderer } from 'electron'
import { desktopIpcChannels } from './types.js'
import type { DesktopBridge } from './types.js'

const bridge: DesktopBridge = {
  connectionSettings: {
    async clear() {
      await ipcRenderer.invoke(desktopIpcChannels.clearConnectionSettings)
    },
    async load() {
      return await ipcRenderer.invoke(desktopIpcChannels.loadConnectionSettings)
    },
    async save(settings) {
      await ipcRenderer.invoke(desktopIpcChannels.saveConnectionSettings, settings)
    },
  },
  preview: {
    async open(url) {
      await ipcRenderer.invoke(desktopIpcChannels.openExternalPreview, url)
    },
  },
}

contextBridge.exposeInMainWorld('remoteAgentDesktopBridge', bridge)

