import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFileConnectionSettingsStore } from './storage.js'
import { desktopIpcChannels } from './types.js'
import type { DesktopConnectionSettings } from './types.js'

function createDesktopHtml(rendererPath: string) {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width,initial-scale=1,viewport-fit=cover"
        />
        <title>RemoteAgentServer Desktop</title>
      </head>
      <body>
        <script type="module" src="${pathToFileURL(rendererPath).href}"></script>
      </body>
    </html>
  `
}

async function createMainWindow() {
  const window = new BrowserWindow({
    backgroundColor: '#08111f',
    height: 980,
    minHeight: 820,
    minWidth: 1180,
    show: false,
    title: 'RemoteAgentServer Desktop',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, 'preload.js'),
    },
    width: 1480,
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      createDesktopHtml(join(import.meta.dirname, 'renderer.js')),
    )}`,
  )
}

async function main() {
  await app.whenReady()

  const settingsStore = createFileConnectionSettingsStore({
    filePath: join(app.getPath('userData'), 'connection-settings.json'),
    safeStorage,
  })

  ipcMain.handle(desktopIpcChannels.loadConnectionSettings, async () => {
    return await settingsStore.load()
  })
  ipcMain.handle(
    desktopIpcChannels.saveConnectionSettings,
    async (_event, settings: DesktopConnectionSettings) => {
      await settingsStore.save(settings)
    },
  )
  ipcMain.handle(desktopIpcChannels.clearConnectionSettings, async () => {
    await settingsStore.clear()
  })
  ipcMain.handle(desktopIpcChannels.openExternalPreview, async (_event, url: string) => {
    await shell.openExternal(url)
  })

  await createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

void main()

