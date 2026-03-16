import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '../..', '..')

const corePackages = ['protocol', 'auth', 'sessions', 'ports', 'providers', 'ui'] as const
const clientApps = ['web', 'mobile', 'desktop'] as const

function readJson(path: string) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as Record<string, unknown>
}

test('US-002 adds the shared core packages with source-first type exports', () => {
  for (const packageName of corePackages) {
    const packageJson = readJson(`packages/${packageName}/package.json`)
    const tsconfig = readJson(`packages/${packageName}/tsconfig.json`)
    const exportsMap = packageJson.exports as Record<string, { types: string; default: string }>

    assert.ok(existsSync(resolve(repoRoot, `packages/${packageName}/src/index.ts`)))
    assert.equal(packageJson.name, `@remote-agent/${packageName}`)
    assert.equal(packageJson.types, './src/index.ts')
    assert.equal(exportsMap['.'].types, './src/index.ts')
    assert.equal(tsconfig.extends, '../../tooling/tsconfig/library.json')
  }
})

test('US-002 rewires apps to consume the focused shared packages directly', () => {
  const serverDependencies = readJson('apps/server/package.json').dependencies as Record<string, string>
  const runtimeDependencies = readJson('apps/runtime/package.json').dependencies as Record<string, string>

  assert.deepEqual(
    Object.keys(serverDependencies).sort(),
    ['@remote-agent/auth', '@remote-agent/ports', '@remote-agent/protocol', '@remote-agent/providers', '@remote-agent/sessions'],
  )
  assert.deepEqual(
    Object.keys(runtimeDependencies).sort(),
    ['@remote-agent/ports', '@remote-agent/protocol', '@remote-agent/providers', '@remote-agent/sessions'],
  )

  for (const appName of clientApps) {
    const packageJson = readJson(`apps/${appName}/package.json`)
    const dependencies = packageJson.dependencies as Record<string, string>
    const source = readFileSync(resolve(repoRoot, `apps/${appName}/src/index.ts`), 'utf8')

    assert.deepEqual(
      Object.keys(dependencies).sort(),
      [
        '@remote-agent/auth',
        '@remote-agent/ports',
        '@remote-agent/protocol',
        '@remote-agent/providers',
        '@remote-agent/sessions',
        '@remote-agent/ui',
      ],
    )
    assert.match(source, /@remote-agent\/ui/)
    assert.match(source, /@remote-agent\/sessions/)
  }
})

test('US-002 documents package boundaries', () => {
  const document = readFileSync(resolve(repoRoot, 'docs/shared-package-boundaries.md'), 'utf8')

  for (const packageName of corePackages) {
    assert.match(document, new RegExp(`@remote-agent/${packageName}`))
  }

  assert.match(document, /Compatibility package/)
  assert.match(document, /Consumption rules/)
})

test('US-002 validates shared package changes through workspace typecheck', () => {
  execFileSync('pnpm', ['typecheck'], {
    cwd: repoRoot,
    stdio: 'pipe',
  })
})
