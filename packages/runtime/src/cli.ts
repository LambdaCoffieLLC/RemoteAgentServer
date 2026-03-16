#!/usr/bin/env node

import process from 'node:process'
import {
  createRuntimeStatusReport,
  enrollRuntime,
  readRuntimeEnrollmentState,
  type RuntimeConnectivity,
  type RuntimeHealth,
  type RuntimeStatus,
} from './status.js'

type RuntimeOptionMap = Record<string, string>

interface ParsedCliArguments {
  command?: string
  options: RuntimeOptionMap
}

function parseArguments(argv: string[]): ParsedCliArguments {
  const [command, ...rest] = argv
  const options: RuntimeOptionMap = {}

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument "${arg}".`)
    }

    const key = arg.slice(2)
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for "--${key}".`)
    }

    options[key] = value
    index += 1
  }

  return { command, options }
}

function getOption(options: RuntimeOptionMap, key: string, envName?: string) {
  return options[key] ?? (envName ? process.env[envName] : undefined)
}

function requireOption(options: RuntimeOptionMap, key: string, envName?: string) {
  const value = getOption(options, key, envName)
  if (!value) {
    throw new Error(`Missing required option "--${key}"${envName ? ` or env "${envName}"` : ''}.`)
  }

  return value
}

function printUsage() {
  process.stdout.write(`Usage:
  remote-agent-runtime enroll --server-url <url> --bootstrap-token <token> --host-id <id> [--host-name <name>] [--state-file <path>]
  remote-agent-runtime status --host-id <id> [--host-name <name>] [--state-file <path>]
`)
}

function asRuntimeStatus(value: string | undefined): RuntimeStatus | undefined {
  if (!value) {
    return undefined
  }

  if (value !== 'online' && value !== 'offline') {
    throw new Error(`Invalid runtime status "${value}".`)
  }

  return value
}

function asRuntimeHealth(value: string | undefined): RuntimeHealth | undefined {
  if (!value) {
    return undefined
  }

  if (value !== 'healthy' && value !== 'degraded' && value !== 'unhealthy') {
    throw new Error(`Invalid runtime health "${value}".`)
  }

  return value
}

function asRuntimeConnectivity(value: string | undefined): RuntimeConnectivity | undefined {
  if (!value) {
    return undefined
  }

  if (value !== 'connected' && value !== 'disconnected') {
    throw new Error(`Invalid runtime connectivity "${value}".`)
  }

  return value
}

async function run() {
  const { command, options } = parseArguments(process.argv.slice(2))

  if (!command || command === 'help' || command === '--help') {
    printUsage()
    return
  }

  if (command === 'enroll') {
    const state = await enrollRuntime({
      serverUrl: requireOption(options, 'server-url', 'RAS_SERVER_URL'),
      bootstrapToken: requireOption(options, 'bootstrap-token', 'RAS_BOOTSTRAP_TOKEN'),
      hostId: requireOption(options, 'host-id', 'RAS_HOST_ID'),
      name: getOption(options, 'host-name', 'RAS_HOST_NAME'),
      platform: getOption(options, 'platform', 'RAS_PLATFORM'),
      stateFile: getOption(options, 'state-file', 'RAS_STATE_FILE'),
      status: asRuntimeStatus(getOption(options, 'status', 'RAS_STATUS')),
      health: asRuntimeHealth(getOption(options, 'health', 'RAS_HEALTH')),
      connectivity: asRuntimeConnectivity(getOption(options, 'connectivity', 'RAS_CONNECTIVITY')),
    })

    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }

  if (command === 'status') {
    const stateFile = getOption(options, 'state-file', 'RAS_STATE_FILE')
    const existingState = stateFile ? await readRuntimeEnrollmentState(stateFile) : undefined

    if (existingState) {
      process.stdout.write(`${JSON.stringify(existingState, null, 2)}\n`)
      return
    }

    const report = createRuntimeStatusReport({
      hostId: requireOption(options, 'host-id', 'RAS_HOST_ID'),
      name: getOption(options, 'host-name', 'RAS_HOST_NAME'),
      platform: getOption(options, 'platform', 'RAS_PLATFORM'),
      status: asRuntimeStatus(getOption(options, 'status', 'RAS_STATUS')),
      health: asRuntimeHealth(getOption(options, 'health', 'RAS_HEALTH')),
      connectivity: asRuntimeConnectivity(getOption(options, 'connectivity', 'RAS_CONNECTIVITY')),
    })

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  throw new Error(`Unknown command "${command}".`)
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Unexpected runtime error.'}\n`)
  process.exitCode = 1
})
