import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  commonDevelopmentPorts,
  suggestManagedPortLabel,
  type PortProtocol,
} from '@remote-agent-server/ports'

const execFileAsync = promisify(execFile)

export interface RuntimeListeningPort {
  pid: number
  command?: string
  cwd?: string
  host: string
  port: number
  protocol: PortProtocol
  suggestedLabel?: string
}

export interface RuntimePortDetectionOptions {
  ports?: readonly number[]
}

function normalizeListeningHost(host: string) {
  if (
    host === '*' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host === '[::]' ||
    host === '[::1]'
  ) {
    return '127.0.0.1'
  }

  const ipv6Match = host.match(/^\[(.*)\]$/)
  return ipv6Match?.[1] ?? host
}

function parseListeningAddress(value: string) {
  const ipv6Match = value.match(/^\[(.*)\]:(\d+)$/)
  if (ipv6Match) {
    return {
      host: normalizeListeningHost(ipv6Match[1]),
      port: Number.parseInt(ipv6Match[2], 10),
    }
  }

  const separatorIndex = value.lastIndexOf(':')
  if (separatorIndex === -1) {
    return undefined
  }

  const host = value.slice(0, separatorIndex)
  const port = Number.parseInt(value.slice(separatorIndex + 1), 10)
  if (!Number.isInteger(port)) {
    return undefined
  }

  return {
    host: normalizeListeningHost(host),
    port,
  }
}

function inferDevelopmentPortProtocol(): PortProtocol {
  return 'http'
}

function createFallbackLabel(command: string | undefined, port: number) {
  if (command && command !== 'node') {
    return `${command} server`
  }

  return `Detected port ${port}`
}

async function readProcessWorkingDirectory(pid: number) {
  try {
    const { stdout } = await execFileAsync('lsof', [
      '-a',
      '-d',
      'cwd',
      '-p',
      String(pid),
      '-Fn',
    ])

    return stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('n'))
      ?.slice(1)
  } catch {
    return undefined
  }
}

export async function detectListeningDevelopmentPorts(
  options: RuntimePortDetectionOptions = {},
): Promise<RuntimeListeningPort[]> {
  const trackedPorts = new Set(options.ports ?? commonDevelopmentPorts)

  try {
    const { stdout } = await execFileAsync('lsof', [
      '-nP',
      '-iTCP',
      '-sTCP:LISTEN',
      '-Fpcn',
    ])

    let currentPid: number | undefined
    let currentCommand: string | undefined
    const listeners: Array<{
      pid: number
      command?: string
      host: string
      port: number
    }> = []

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim()
      if (line.length === 0) {
        continue
      }

      if (line.startsWith('p')) {
        const pid = Number.parseInt(line.slice(1), 10)
        currentPid = Number.isInteger(pid) ? pid : undefined
        currentCommand = undefined
        continue
      }

      if (line.startsWith('c')) {
        currentCommand = line.slice(1)
        continue
      }

      if (!line.startsWith('n') || currentPid === undefined) {
        continue
      }

      const parsedAddress = parseListeningAddress(line.slice(1))
      if (!parsedAddress || !trackedPorts.has(parsedAddress.port)) {
        continue
      }

      listeners.push({
        pid: currentPid,
        command: currentCommand,
        host: parsedAddress.host,
        port: parsedAddress.port,
      })
    }

    const uniqueProcessIds = [...new Set(listeners.map((listener) => listener.pid))]
    const cwdEntries = await Promise.all(
      uniqueProcessIds.map(async (pid) => [pid, await readProcessWorkingDirectory(pid)] as const),
    )
    const cwdByPid = new Map<number, string | undefined>(cwdEntries)
    const seen = new Set<string>()

    return listeners
      .filter((listener) => {
        const key = `${listener.pid}:${listener.host}:${listener.port}`
        if (seen.has(key)) {
          return false
        }

        seen.add(key)
        return true
      })
      .map((listener) => {
        const protocol = inferDevelopmentPortProtocol()
        return {
          ...listener,
          cwd: cwdByPid.get(listener.pid),
          protocol,
          suggestedLabel:
            suggestManagedPortLabel({
              port: listener.port,
              protocol,
            }) ?? createFallbackLabel(listener.command, listener.port),
        } satisfies RuntimeListeningPort
      })
      .sort((left, right) => left.port - right.port || left.pid - right.pid)
  } catch (error) {
    const candidate = error as { code?: number | string }
    if (candidate.code === 1 || candidate.code === 'ENOENT') {
      return []
    }

    throw error
  }
}
