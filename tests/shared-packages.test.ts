import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

type PackageJson = {
  name?: string
  main?: string
  types?: string
  exports?: {
    '.': {
      import?: string
      types?: string
    }
  }
  dependencies?: Record<string, string>
}

const repoRoot = resolve(import.meta.dirname, '..')
const sharedPackages = ['auth', 'ports', 'protocol', 'providers', 'sessions', 'ui'] as const
const consumerEntryPoints = [
  'apps/server/src/index.ts',
  'apps/web/src/index.ts',
  'apps/mobile/src/index.ts',
  'apps/desktop/src/index.ts',
  'packages/runtime/src/index.ts',
]

const uiConsumers = new Set(['apps/web/src/index.ts', 'apps/mobile/src/index.ts', 'apps/desktop/src/index.ts'])

let built = false

function readText(relativePath: string) {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

function readJson<T>(relativePath: string) {
  return JSON.parse(readText(relativePath)) as T
}

function ensureBuilt() {
  if (built) {
    return
  }

  execFileSync('pnpm', ['build'], {
    cwd: repoRoot,
    stdio: 'pipe',
  })
  built = true
}

test('shared core packages exist and the legacy shared scaffold is gone', () => {
  for (const packageName of sharedPackages) {
    const packageRoot = `packages/${packageName}`
    assert.equal(existsSync(join(repoRoot, packageRoot, 'package.json')), true, `${packageRoot} should exist`)
    assert.equal(existsSync(join(repoRoot, packageRoot, 'src/index.ts')), true, `${packageRoot} source should exist`)
  }

  assert.equal(existsSync(join(repoRoot, 'packages/shared/package.json')), false)
})

test('shared package entrypoints point at runtime-safe build outputs', async () => {
  ensureBuilt()

  for (const packageName of sharedPackages) {
    const packageJson = readJson<PackageJson>(`packages/${packageName}/package.json`)

    assert.equal(packageJson.name, `@remote-agent-server/${packageName}`)
    assert.equal(packageJson.main, 'dist/index.js')
    assert.equal(packageJson.types, 'src/index.ts')
    assert.equal(packageJson.exports?.['.']?.import, './dist/index.js')
    assert.equal(packageJson.exports?.['.']?.types, './src/index.ts')
    assert.equal(existsSync(join(repoRoot, 'packages', packageName, 'dist/index.js')), true)

    const moduleExports = (await import(
      pathToFileURL(join(repoRoot, 'packages', packageName, 'dist/index.js')).href
    )) as Record<string, unknown>

    assert.ok(Object.keys(moduleExports).length > 0, `${packageName} should expose runtime exports`)
  }
})

test('server, runtime, and clients import the shared domain packages', () => {
  const requiredImports = [
    '@remote-agent-server/auth',
    '@remote-agent-server/ports',
    '@remote-agent-server/protocol',
    '@remote-agent-server/providers',
    '@remote-agent-server/sessions',
  ]

  for (const entryPoint of consumerEntryPoints) {
    const source = readText(entryPoint)

    for (const importPath of requiredImports) {
      assert.match(source, new RegExp(importPath.replaceAll('/', '\\/')))
    }

    if (uiConsumers.has(entryPoint)) {
      assert.match(source, /@remote-agent-server\/ui/)
    }

    assert.doesNotMatch(source, /@remote-agent-server\/shared/)
  }
})

test('README documents package responsibilities and dependency boundaries', () => {
  const readme = readText('README.md')

  assert.match(readme, /Shared Package Boundaries/)
  assert.match(readme, /@remote-agent-server\/protocol/)
  assert.match(readme, /@remote-agent-server\/auth/)
  assert.match(readme, /@remote-agent-server\/sessions/)
  assert.match(readme, /@remote-agent-server\/ports/)
  assert.match(readme, /@remote-agent-server\/providers/)
  assert.match(readme, /@remote-agent-server\/ui/)
  assert.match(readme, /dependency direction/i)
})
