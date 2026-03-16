import * as SecureStore from 'expo-secure-store'
import { StatusBar } from 'expo-status-bar'
import * as WebBrowser from 'expo-web-browser'
import { Linking } from 'react-native'
import { MobileOperatorApp } from './src/MobileOperatorApp.js'
import { createMobileControlPlaneClient } from './src/client.js'
import { MobileOperatorController } from './src/controller.js'
import { createExpoPreviewOpener } from './src/expo-preview.js'
import { createExpoConnectionSettingsStore } from './src/expo-storage.js'
import { createReactNativeSseConnector } from './src/react-native-events.js'

const connectionSettingsStore = createExpoConnectionSettingsStore(SecureStore)
const previewOpener = createExpoPreviewOpener({
  openBrowserAsync: WebBrowser.openBrowserAsync,
  openUrl: async (url) => {
    await Linking.openURL(url)
  },
})
const eventConnector = createReactNativeSseConnector()

const controller = new MobileOperatorController({
  createClient: (settings) =>
    createMobileControlPlaneClient({
      ...settings,
      eventConnector,
    }),
  previewOpener,
  settingsStore: connectionSettingsStore,
})

export default function App() {
  return (
    <>
      <StatusBar style="dark" />
      <MobileOperatorApp controller={controller} />
    </>
  )
}
