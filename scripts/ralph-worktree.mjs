#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(scriptPath), '..')
const repoName = basename(repoRoot)
const prd = JSON.parse(readFileSync(resolve(repoRoot, 'prd.json'), 'utf8'))
const branchName = String(prd.branchName)
const baseBranch = process.env.RALPH_WORKTREE_BASE_BRANCH ?? 'main'
const worktreeRoot =
  process.env.RALPH_WORKTREE_ROOT ?? resolve(repoRoot, '..', '.ralph-worktrees', repoName)
const targetPath = resolve(worktreeRoot, branchName)
const args = new Set(process.argv.slice(2))
const printPathOnly = args.has('--print-path')

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function runChecked(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function ensureCleanBaseRepo() {
  const result = run('git', ['status', '--porcelain'])
  if ((result.stdout ?? '').trim()) {
    console.error('Refusing to prepare Ralph worktree from a dirty base repo. Commit, stash, or clean changes first.')
    process.exit(1)
  }
}

function parseWorktrees() {
  const result = run('git', ['worktree', 'list', '--porcelain'])
  if (result.status !== 0) {
    console.error(result.stderr || 'Failed to list git worktrees.')
    process.exit(result.status ?? 1)
  }

  const worktrees = []
  let current = null
  for (const line of (result.stdout ?? '').split('\n')) {
    if (!line.trim()) {
      if (current) worktrees.push(current)
      current = null
      continue
    }
    const [key, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (key === 'worktree') {
      current = { path: value, branch: null }
      continue
    }
    if (!current) continue
    if (key === 'branch') {
      current.branch = value.replace('refs/heads/', '')
    }
  }
  if (current) worktrees.push(current)
  return worktrees
}

function ensureWorktree() {
  ensureCleanBaseRepo()

  const worktrees = parseWorktrees()
  const byBranch = worktrees.find((entry) => entry.branch === branchName)
  if (byBranch) {
    return byBranch.path
  }

  const byPath = worktrees.find((entry) => resolve(entry.path) === targetPath)
  if (byPath) {
    return byPath.path
  }

  runChecked('git', ['worktree', 'add', '-B', branchName, targetPath, baseBranch])
  return targetPath
}

const worktreePath = ensureWorktree()

if (printPathOnly) {
  process.stdout.write(`${worktreePath}\n`)
} else {
  console.log(`Prepared Ralph worktree:`)
  console.log(worktreePath)
  console.log(`Branch: ${branchName}`)
}
