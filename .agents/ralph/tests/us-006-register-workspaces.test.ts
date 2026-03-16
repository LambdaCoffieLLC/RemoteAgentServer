import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

test('US-006 registers repository paths as managed workspaces with inspect and remove flows', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-006-'))
  const storagePath = join(tempDir, 'control-plane-state.json')
  const repositoryPath = join(tempDir, 'repositories', 'app')

  initializeGitRepository(repositoryPath)
  const canonicalRepositoryPath = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()

  let handle: Awaited<ReturnType<typeof startControlPlaneHttpServer>> | undefined = await startControlPlaneHttpServer({
    bootstrapTokens: ['bootstrap-us-006'],
    storagePath,
  })

  try {
    const runtimeEnrollment = await fetch(`${handle.origin}/v1/runtime/enroll`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bootstrap-token': 'bootstrap-us-006',
      },
      body: JSON.stringify({
        hostId: 'host_repo',
        label: 'Repository Host',
        platform: 'linux',
        runtimeId: 'runtime_repo',
        runtimeLabel: 'Repository Runtime',
        version: '1.0.0',
        health: 'healthy',
        connectivity: 'connected',
      }),
    })

    assert.equal(runtimeEnrollment.status, 201)

    const createdWorkspace = await postJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_repo',
      hostId: 'host_repo',
      repositoryPath,
    })

    assert.equal(createdWorkspace.data.hostId, 'host_repo')
    assert.equal(createdWorkspace.data.path, canonicalRepositoryPath)
    assert.equal(createdWorkspace.data.repositoryPath, canonicalRepositoryPath)
    assert.equal(createdWorkspace.data.defaultBranch, 'main')
    assert.deepEqual(createdWorkspace.data.runtimeAssociation, {
      hostId: 'host_repo',
      runtimeId: 'runtime_repo',
      label: 'Repository Runtime',
    })

    const listedWorkspaces = await getJson(handle.origin, '/v1/workspaces')
    assert.equal(listedWorkspaces.data.length, 1)

    const inspectedWorkspace = await getWorkspace(handle.origin, 'workspace_repo')
    assert.equal(inspectedWorkspace.data.id, 'workspace_repo')
    assert.equal(inspectedWorkspace.data.path, canonicalRepositoryPath)
    assert.equal(inspectedWorkspace.data.defaultBranch, 'main')
    assert.equal(inspectedWorkspace.data.runtimeAssociation.runtimeId, 'runtime_repo')

    const invalidWorkspaceResponse = await fetch(`${handle.origin}/v1/workspaces`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({
        id: 'workspace_missing',
        hostId: 'host_repo',
        repositoryPath: join(tempDir, 'repositories', 'missing'),
      }),
    })

    assert.equal(invalidWorkspaceResponse.status, 400)
    const invalidWorkspacePayload = (await invalidWorkspaceResponse.json()) as {
      error: {
        code: string
        message: string
      }
    }
    assert.equal(invalidWorkspacePayload.error.code, 'invalid_workspace_path')
    assert.match(invalidWorkspacePayload.error.message, /not accessible/i)

    const removedWorkspace = await deleteWorkspace(handle.origin, 'workspace_repo')
    assert.equal(removedWorkspace.data.id, 'workspace_repo')

    const emptyWorkspaceList = await getJson(handle.origin, '/v1/workspaces')
    assert.equal(emptyWorkspaceList.data.length, 0)

    const missingWorkspaceResponse = await fetch(`${handle.origin}/v1/workspaces/workspace_repo`, {
      headers: viewerHeaders,
    })
    assert.equal(missingWorkspaceResponse.status, 404)
  } finally {
    if (handle) {
      await handle.close()
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})

function initializeGitRepository(repositoryPath: string) {
  mkdirSync(repositoryPath, { recursive: true })
  execFileSync('git', ['init', repositoryPath], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' })
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`, {
    headers: viewerHeaders,
  })

  assert.equal(response.status, 200)
  return (await response.json()) as { data: Array<Record<string, unknown>> }
}

async function getWorkspace(origin: string, workspaceId: string) {
  const response = await fetch(`${origin}/v1/workspaces/${workspaceId}`, {
    headers: viewerHeaders,
  })

  assert.equal(response.status, 200)
  return (await response.json()) as {
    data: {
      id: string
      path: string
      defaultBranch: string
      runtimeAssociation: {
        runtimeId?: string
      }
    }
  }
}

async function postJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 201)
  return response.json() as Promise<{
    data: {
      id: string
      hostId: string
      path: string
      repositoryPath: string
      defaultBranch: string
      runtimeAssociation: {
        hostId: string
        runtimeId?: string
        label: string
      }
    }
  }>
}

async function deleteWorkspace(origin: string, workspaceId: string) {
  const response = await fetch(`${origin}/v1/workspaces/${workspaceId}`, {
    method: 'DELETE',
    headers: operatorHeaders,
  })

  assert.equal(response.status, 200)
  return response.json() as Promise<{
    data: {
      id: string
    }
  }>
}
