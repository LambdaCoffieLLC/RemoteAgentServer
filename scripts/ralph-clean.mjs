#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(scriptPath), '..')
const args = new Set(process.argv.slice(2))
const includeNodeModules = args.has('--include-node-modules')
const dryRun = args.has('--dry-run')

const cleanupTargets = [
  '.agents/ralph/latest-run.json',
  '.agents/ralph/logs',
  '.agents/ralph/verification',
  'apps',
  'packages',
]

if (includeNodeModules) {
  cleanupTargets.push('node_modules')
}

const gitArgs = ['clean', dryRun ? '-fdxn' : '-fdx', '--', ...cleanupTargets]
const result = spawnSync('git', gitArgs, {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (result.stdout) {
  process.stdout.write(result.stdout)
}

if (result.stderr) {
  process.stderr.write(result.stderr)
}

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

if (!result.stdout.trim()) {
  console.log(
    dryRun
      ? 'No generated Ralph artifacts to clean.'
      : 'No generated Ralph artifacts needed cleanup.',
  )
}
