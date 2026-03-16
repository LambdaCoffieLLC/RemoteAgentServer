import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startControlPlaneHttpServer } from '../../../apps/server/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

const viewerHeaders = {
  authorization: 'Bearer control-plane-viewer',
}

test('US-009 creates isolated session worktrees while still allowing direct workspace mode', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-009-'))
  const storagePath = join(tempDir, 'control-plane-state.json')
  const repositoryPath = join(tempDir, 'repositories', 'app')

  initializeCommittedGitRepository(repositoryPath)
  const canonicalRepositoryPath = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()

  let handle: Awaited<ReturnType<typeof startControlPlaneHttpServer>> | undefined = await startControlPlaneHttpServer({ storagePath })

  try {
    await postCreatedJson(handle.origin, '/v1/hosts', {
      id: 'host_worktrees',
      label: 'Worktree Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })
    await postCreatedJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_repo',
      hostId: 'host_worktrees',
      repositoryPath,
    })

    const directSession = await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_direct',
      hostId: 'host_worktrees',
      workspaceId: 'workspace_repo',
      provider: 'codex',
      workspaceMode: 'direct',
    })
    assert.equal(directSession.data.workspace.mode, 'direct')
    assert.equal(directSession.data.workspace.path, canonicalRepositoryPath)
    assert.equal(directSession.data.workspace.repositoryPath, canonicalRepositoryPath)
    assert.equal(directSession.data.workspace.worktree, undefined)

    const worktreeSession = await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_worktree',
      hostId: 'host_worktrees',
      workspaceId: 'workspace_repo',
      provider: 'codex',
      workspaceMode: 'worktree',
    })
    const worktreeMetadata = worktreeSession.data.workspace.worktree
    assert.equal(worktreeSession.data.workspace.mode, 'worktree')
    assert.equal(worktreeSession.data.workspace.repositoryPath, canonicalRepositoryPath)
    assert.ok(worktreeSession.data.workspace.path.endsWith(join('app', 'session_worktree')))
    assert.ok(worktreeMetadata)
    assert.equal(worktreeMetadata.branch, 'session/session_worktree')
    assert.equal(worktreeMetadata.baseBranch, 'main')
    assert.equal(
      execFileSync('git', ['-C', worktreeSession.data.workspace.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      'session/session_worktree',
    )

    writeFileSync(join(repositoryPath, 'README.md'), '# dirty\n', 'utf8')

    const dirtyRejectedResponse = await fetch(`${handle.origin}/v1/sessions`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({
        id: 'session_dirty_rejected',
        hostId: 'host_worktrees',
        workspaceId: 'workspace_repo',
        provider: 'codex',
        workspaceMode: 'worktree',
      }),
    })
    assert.equal(dirtyRejectedResponse.status, 409)
    const dirtyRejectedPayload = (await dirtyRejectedResponse.json()) as {
      error: {
        code: string
        message: string
      }
    }
    assert.equal(dirtyRejectedPayload.error.code, 'dirty_workspace')
    assert.match(dirtyRejectedPayload.error.message, /allowdirtyworkspace=true/i)

    const dirtyAllowedSession = await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_dirty_allowed',
      hostId: 'host_worktrees',
      workspaceId: 'workspace_repo',
      provider: 'codex',
      workspaceMode: 'worktree',
      allowDirtyWorkspace: true,
    })
    const dirtyAllowedWorktree = dirtyAllowedSession.data.workspace.worktree
    assert.equal(dirtyAllowedSession.data.workspace.mode, 'worktree')
    assert.equal(dirtyAllowedSession.data.workspace.allowDirtyWorkspace, true)
    assert.ok(dirtyAllowedWorktree)
    assert.equal(dirtyAllowedWorktree.dirtyWorkspaceAllowed, true)

    await handle.close()
    handle = undefined
    handle = await startControlPlaneHttpServer({ storagePath })

    const persistedSession = await getJson(handle.origin, '/v1/sessions/session_worktree')
    assert.equal(persistedSession.data.workspace.mode, 'worktree')
    assert.equal(persistedSession.data.workspace.worktree.branch, 'session/session_worktree')
    assert.equal(persistedSession.data.workspace.path, worktreeSession.data.workspace.path)
  } finally {
    if (handle) {
      await handle.close()
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})

function initializeCommittedGitRepository(repositoryPath: string) {
  execFileSync('git', ['init', repositoryPath], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Remote Agent Tests'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'tests@example.com'], { stdio: 'ignore' })
  writeFileSync(join(repositoryPath, 'README.md'), '# app\n', 'utf8')
  execFileSync('git', ['-C', repositoryPath, 'add', 'README.md'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'commit', '-m', 'Initial commit'], { stdio: 'ignore' })
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`, {
    headers: viewerHeaders,
  })

  assert.equal(response.status, 200)
  return (await response.json()) as {
    data: {
      workspace: {
        mode: string
        path: string
        worktree: {
          branch: string
        }
      }
    }
  }
}

async function postCreatedJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 201)
  return (await response.json()) as {
    data: {
      workspace: {
        mode: string
        repositoryPath: string
        path: string
        allowDirtyWorkspace: boolean
        worktree?: {
          branch: string
          baseBranch: string
          dirtyWorkspaceAllowed: boolean
        }
      }
    }
  }
}
