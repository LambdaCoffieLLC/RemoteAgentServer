import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { startControlPlaneServer } from '../apps/server/src/index.js'
import { createSessionReviewClient } from '../apps/web/src/index.js'

const execFileAsync = promisify(execFile)

async function createTempDir() {
  return mkdtemp(join(tmpdir(), 'remote-agent-server-diff-review-'))
}

function operatorHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }
}

function bootstrapHeaders(token: string) {
  return {
    'content-type': 'application/json',
    'x-bootstrap-token': token,
  }
}

async function readJson(response: Response) {
  return (await response.json()) as { data?: unknown; error?: string }
}

async function createCommittedRepository(rootDir: string, repoName = 'repo') {
  const repositoryPath = join(rootDir, repoName)
  await mkdir(repositoryPath, { recursive: true })
  await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'test@example.com'])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Test User'])

  await writeFile(join(repositoryPath, 'modified.txt'), 'base line\n', 'utf8')
  await writeFile(join(repositoryPath, 'old-name.txt'), 'rename me\n', 'utf8')
  await writeFile(join(repositoryPath, 'removed.txt'), 'remove me\n', 'utf8')

  await execFileAsync('git', ['-C', repositoryPath, 'add', '.'])
  await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'initial state'])
  return repositoryPath
}

async function registerSession(baseUrl: string, repositoryPath: string) {
  const hostResponse = await fetch(`${baseUrl}/api/hosts`, {
    method: 'POST',
    headers: bootstrapHeaders('bootstrap-secret'),
    body: JSON.stringify({
      id: 'host-1',
      name: 'devbox',
      platform: 'linux',
      runtimeVersion: '0.1.0',
      status: 'online',
    }),
  })
  assert.equal(hostResponse.status, 201)

  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: operatorHeaders('operator-secret'),
    body: JSON.stringify({
      id: 'workspace-1',
      hostId: 'host-1',
      path: repositoryPath,
    }),
  })
  assert.equal(workspaceResponse.status, 201)

  const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: operatorHeaders('operator-secret'),
    body: JSON.stringify({
      id: 'session-1',
      workspaceId: 'workspace-1',
      provider: 'codex',
    }),
  })
  assert.equal(sessionResponse.status, 201)
}

async function createReviewChanges(repositoryPath: string) {
  await writeFile(join(repositoryPath, 'modified.txt'), `${'changed line\n'.repeat(12)}`, 'utf8')
  await execFileAsync('git', ['-C', repositoryPath, 'mv', 'old-name.txt', 'renamed.txt'])
  await rm(join(repositoryPath, 'removed.txt'))
  await writeFile(join(repositoryPath, 'added.txt'), `${'new line\n'.repeat(60)}`, 'utf8')
  await execFileAsync('git', ['-C', repositoryPath, 'add', '-A'])
}

test('control plane lists changed files and paginates diffs for a session', async () => {
  const tempDir = await createTempDir()
  const repositoryPath = await createCommittedRepository(tempDir)
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
  })

  try {
    await registerSession(server.url, repositoryPath)
    await createReviewChanges(repositoryPath)

    const changesResponse = await fetch(`${server.url}/api/sessions/session-1/changes`, {
      headers: {
        authorization: 'Bearer operator-secret',
      },
    })

    assert.equal(changesResponse.status, 200)
    const changes = (await readJson(changesResponse)).data as {
      files: Array<{ path: string; previousPath?: string; kind: string }>
      summary: { text: string }
    }

    assert.deepEqual(
      changes.files.map((file) => ({ path: file.path, previousPath: file.previousPath, kind: file.kind })),
      [
        { path: 'added.txt', previousPath: undefined, kind: 'added' },
        { path: 'modified.txt', previousPath: undefined, kind: 'modified' },
        { path: 'removed.txt', previousPath: undefined, kind: 'removed' },
        { path: 'renamed.txt', previousPath: 'old-name.txt', kind: 'renamed' },
      ],
    )
    assert.match(changes.summary.text, /^4 changed files/m)
    assert.match(changes.summary.text, /^R old-name\.txt -> renamed\.txt$/m)

    const renamedDiffResponse = await fetch(
      `${server.url}/api/sessions/session-1/diff?path=renamed.txt&page=1&pageSize=40`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(renamedDiffResponse.status, 200)
    const renamedDiff = (await readJson(renamedDiffResponse)).data as { text: string; truncated: boolean }
    assert.match(renamedDiff.text, /rename from old-name\.txt/)
    assert.match(renamedDiff.text, /rename to renamed\.txt/)
    assert.equal(renamedDiff.truncated, false)

    const firstPageResponse = await fetch(
      `${server.url}/api/sessions/session-1/diff?path=added.txt&page=1&pageSize=12`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(firstPageResponse.status, 200)
    const firstPage = (await readJson(firstPageResponse)).data as {
      text: string
      page: number
      pageSize: number
      totalLines: number
      totalPages: number
      truncated: boolean
      nextPage?: number
    }

    assert.equal(firstPage.page, 1)
    assert.equal(firstPage.pageSize, 12)
    assert.ok(firstPage.totalLines > 12)
    assert.ok(firstPage.totalPages > 1)
    assert.equal(firstPage.truncated, true)
    assert.equal(firstPage.nextPage, 2)
    assert.match(firstPage.text, /diff --git a\/added\.txt b\/added\.txt/)

    const secondPageResponse = await fetch(
      `${server.url}/api/sessions/session-1/diff?path=added.txt&page=2&pageSize=12`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(secondPageResponse.status, 200)
    const secondPage = (await readJson(secondPageResponse)).data as {
      text: string
      page: number
      previousPage?: number
    }

    assert.equal(secondPage.page, 2)
    assert.equal(secondPage.previousPage, 1)
    assert.notEqual(secondPage.text, firstPage.text)
  } finally {
    await server.close()
  }
})

test('web client can review session changes and diff pages without raw fetch handling', async () => {
  const tempDir = await createTempDir()
  const repositoryPath = await createCommittedRepository(tempDir)
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
  })

  try {
    await registerSession(server.url, repositoryPath)
    await createReviewChanges(repositoryPath)

    const client = createSessionReviewClient({
      baseUrl: server.url,
      token: 'operator-secret',
    })

    const changes = await client.listChangedFiles('session-1')
    assert.equal(changes.files.length, 4)
    assert.deepEqual(
      changes.files.map((file) => file.kind),
      ['added', 'modified', 'removed', 'renamed'],
    )

    const diff = await client.viewDiff('session-1', {
      path: 'added.txt',
      page: 1,
      pageSize: 10,
    })

    assert.equal(diff.page, 1)
    assert.equal(diff.pageSize, 10)
    assert.equal(diff.truncated, true)
    assert.equal(diff.nextPage, 2)
    assert.match(diff.text, /^\+\+\+ b\/added\.txt/m)
  } finally {
    await server.close()
  }
})
