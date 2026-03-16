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

test('US-010 lists changed files and returns paginated, truncated session diffs with patch summaries', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-010-'))
  const storagePath = join(tempDir, 'control-plane-state.json')
  const repositoryPath = join(tempDir, 'repositories', 'app')

  initializeCommittedGitRepository(repositoryPath)

  const handle = await startControlPlaneHttpServer({ storagePath })

  try {
    await postCreatedJson(handle.origin, '/v1/hosts', {
      id: 'host_changes',
      label: 'Changes Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })
    await postCreatedJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_changes',
      hostId: 'host_changes',
      repositoryPath,
    })
    await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_review',
      hostId: 'host_changes',
      workspaceId: 'workspace_changes',
      provider: 'codex',
      workspaceMode: 'direct',
    })

    writeFileSync(join(repositoryPath, 'README.md'), '# app\n\nupdated\n', 'utf8')
    execFileSync('git', ['-C', repositoryPath, 'mv', 'rename-me.txt', 'renamed.txt'], { stdio: 'ignore' })
    rmSync(join(repositoryPath, 'delete-me.txt'))
    writeFileSync(
      join(repositoryPath, 'large.txt'),
      Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n') + '\n',
      'utf8',
    )

    const firstPage = await getJson<SessionChangesResponse>(handle.origin, '/v1/sessions/session_review/changes?limit=2')
    assert.equal(firstPage.data.page.limit, 2)
    assert.equal(firstPage.data.page.total, 4)
    assert.equal(firstPage.data.page.nextCursor, 2)
    assert.deepEqual(firstPage.data.summary, {
      totalFiles: 4,
      added: 1,
      modified: 1,
      renamed: 1,
      removed: 1,
    })

    const secondPage = await getJson<SessionChangesResponse>(handle.origin, '/v1/sessions/session_review/changes?limit=2&cursor=2')
    assert.equal(secondPage.data.page.total, 4)
    assert.equal(secondPage.data.page.nextCursor, undefined)

    const changedFiles = [...firstPage.data.items, ...secondPage.data.items]
    const changedFilesByPath = new Map(changedFiles.map((entry) => [entry.path, entry]))
    assert.equal(changedFilesByPath.get('README.md')?.changeType, 'modified')
    assert.equal(changedFilesByPath.get('delete-me.txt')?.changeType, 'removed')
    assert.equal(changedFilesByPath.get('large.txt')?.changeType, 'added')
    assert.equal(changedFilesByPath.get('renamed.txt')?.changeType, 'renamed')
    assert.equal(changedFilesByPath.get('renamed.txt')?.previousPath, 'rename-me.txt')

    const renamedPatch = await getJson<SessionDiffResponse>(
      handle.origin,
      '/v1/sessions/session_review/changes/patch?path=renamed.txt&limit=1&maxBytes=512',
    )
    assert.equal(renamedPatch.data.items.length, 1)
    assert.equal(renamedPatch.data.items[0]?.changeType, 'renamed')
    assert.equal(renamedPatch.data.items[0]?.previousPath, 'rename-me.txt')
    assert.match(renamedPatch.data.items[0]?.patch ?? '', /rename from rename-me\.txt/)

    const diffPage = await getJson<SessionDiffResponse>(
      handle.origin,
      '/v1/sessions/session_review/changes/patch?limit=4&maxBytes=160',
    )
    assert.equal(diffPage.data.page.total, 4)
    assert.deepEqual(diffPage.data.summary, {
      totalFiles: 4,
      added: 1,
      modified: 1,
      renamed: 1,
      removed: 1,
    })
    assert.ok(diffPage.data.patchSummary.additions > 0)
    assert.ok(diffPage.data.patchSummary.deletions > 0)
    assert.equal(diffPage.data.truncated, true)

    const diffEntriesByPath = new Map(diffPage.data.items.map((entry) => [entry.path, entry]))
    assert.equal(diffEntriesByPath.get('large.txt')?.patchTruncated, true)
    assert.match(diffEntriesByPath.get('large.txt')?.patch ?? '', /diff truncated/)
    assert.ok((diffEntriesByPath.get('README.md')?.additions ?? 0) > 0)
    assert.ok((diffEntriesByPath.get('delete-me.txt')?.deletions ?? 0) > 0)
  } finally {
    await handle.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function initializeCommittedGitRepository(repositoryPath: string) {
  execFileSync('git', ['init', repositoryPath], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Remote Agent Tests'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'tests@example.com'], { stdio: 'ignore' })
  writeFileSync(join(repositoryPath, 'README.md'), '# app\n', 'utf8')
  writeFileSync(join(repositoryPath, 'rename-me.txt'), 'rename me\n', 'utf8')
  writeFileSync(join(repositoryPath, 'delete-me.txt'), 'delete me\n', 'utf8')
  execFileSync('git', ['-C', repositoryPath, 'add', 'README.md', 'rename-me.txt', 'delete-me.txt'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'commit', '-m', 'Initial commit'], { stdio: 'ignore' })
}

async function getJson<TResponse>(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`, {
    headers: viewerHeaders,
  })

  assert.equal(response.status, 200)
  return (await response.json()) as TResponse
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
      id?: string
    }
  }
}

interface SessionChangedFile {
  path: string
  previousPath?: string
  changeType: 'added' | 'modified' | 'renamed' | 'removed'
}

interface SessionChangesResponse {
  data: {
    items: SessionChangedFile[]
    page: {
      limit: number
      total: number
      nextCursor?: number
    }
    summary: {
      totalFiles: number
      added: number
      modified: number
      renamed: number
      removed: number
    }
  }
}

interface SessionDiffResponse {
  data: {
    items: Array<
      SessionChangedFile & {
        patch: string
        patchTruncated: boolean
        additions: number
        deletions: number
      }
    >
    page: {
      total: number
    }
    summary: SessionChangesResponse['data']['summary']
    patchSummary: {
      additions: number
      deletions: number
    }
    truncated: boolean
  }
}
