import * as Linking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import type { MobilePreviewOpeners } from './index.js'

export function createExpoPreviewOpeners(): MobilePreviewOpeners {
  return {
    openInAppBrowser: async (url) => await WebBrowser.openBrowserAsync(url),
    openSystemBrowser: async (url) => await Linking.openURL(url),
  }
}
