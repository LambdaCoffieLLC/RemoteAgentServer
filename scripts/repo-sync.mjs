#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(scriptPath), '..')
const [command = 'push'] = process.argv.slice(2)

const syncHost = process.env.RAS_SYNC_HOST?.trim() ?? ''
const syncRepoPath = process.env.RAS_SYNC_REPO_PATH?.trim() ?? ''
const syncBranch =
  process.env.RAS_SYNC_BRANCH?.trim() || run('git', ['branch', '--show-current'])
const syncRemote = process.env.RAS_SYNC_REMOTE?.trim() || 'origin'
const syncGitUrl =
  process.env.RAS_SYNC_GIT_URL?.trim() ||
  run('git', ['config', '--get', `remote.${syncRemote}.url`])

function run(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

function runChecked(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function requireSyncConfig() {
  if (!syncHost || !syncRepoPath) {
    console.error(
      'Missing sync configuration. Set RAS_SYNC_HOST and RAS_SYNC_REPO_PATH.',
    )
    process.exit(1)
  }
}

function ensureCleanWorktree() {
  const dirty = run('git', ['status', '--short'])
  if (dirty) {
    console.error(
      'Refusing to sync a dirty worktree. Commit or stash changes first.',
    )
    process.exit(1)
  }
}

function buildRemoteBootstrapScript() {
  const quotedPath = shellQuote(syncRepoPath)
  const quotedGitUrl = shellQuote(syncGitUrl)
  const quotedRemote = shellQuote(syncRemote)
  const quotedBranch = shellQuote(syncBranch)

  return `
set -euo pipefail
repo_path=${quotedPath}
git_url=${quotedGitUrl}
remote_name=${quotedRemote}
branch_name=${quotedBranch}
mkdir -p "$(dirname "$repo_path")"
if [ ! -d "$repo_path/.git" ]; then
  git clone "$git_url" "$repo_path"
fi
git -C "$repo_path" fetch "$remote_name" "$branch_name"
if git -C "$repo_path" show-ref --verify --quiet "refs/heads/$branch_name"; then
  git -C "$repo_path" checkout "$branch_name"
else
  git -C "$repo_path" checkout -B "$branch_name" "$remote_name/$branch_name"
fi
git -C "$repo_path" reset --hard "$remote_name/$branch_name"
git -C "$repo_path" clean -fdx
git -C "$repo_path" rev-parse --short HEAD
`.trim()
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function runRemote(script) {
  runChecked('ssh', [syncHost, script], { cwd: repoRoot })
}

switch (command) {
  case 'config': {
    requireSyncConfig()
    console.log(`host=${syncHost}`)
    console.log(`repoPath=${syncRepoPath}`)
    console.log(`branch=${syncBranch}`)
    console.log(`remote=${syncRemote}`)
    console.log(`gitUrl=${syncGitUrl}`)
    break
  }
  case 'push': {
    requireSyncConfig()
    ensureCleanWorktree()
    console.log(`Pushing ${syncBranch} to ${syncRemote}...`)
    runChecked('git', ['push', syncRemote, syncBranch], { cwd: repoRoot })
    console.log(`Syncing ${syncBranch} to ${syncHost}:${syncRepoPath}...`)
    runRemote(buildRemoteBootstrapScript())
    break
  }
  case 'remote-status': {
    requireSyncConfig()
    runRemote(`
set -euo pipefail
repo_path=${shellQuote(syncRepoPath)}
if [ ! -d "$repo_path/.git" ]; then
  echo "missing"
  exit 0
fi
echo "path=$repo_path"
git -C "$repo_path" branch --show-current
git -C "$repo_path" rev-parse --short HEAD
git -C "$repo_path" status --short
`.trim())
    break
  }
  default: {
    console.error(
      `Unknown command "${command}". Use one of: push, config, remote-status.`,
    )
    process.exit(1)
  }
}
