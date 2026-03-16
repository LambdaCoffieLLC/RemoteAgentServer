import { renderWebClient } from './app.js'
import './styles.css'

const mount = globalThis.document.getElementById('app')

if (!(mount instanceof HTMLElement)) {
  throw new Error('RemoteAgentServer web client could not find the app mount node.')
}

renderWebClient(mount)
