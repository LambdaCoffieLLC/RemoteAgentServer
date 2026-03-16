import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '../..', '..')

const workspacePackages = [
  { path: 'apps/server', config: 'app' },
  { path: 'apps/runtime', config: 'app' },
  { path: 'apps/web', config: 'app' },
  { path: 'apps/mobile', config: 'app' },
  { path: 'apps/desktop', config: 'app' },
  { path: 'packages/shared', config: 'library' },
] as const

function readJson(path: string) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as Record<string, unknown>
}

test('US-001 configures pnpm workspaces and centralized tooling', () => {
  const workspaceFile = readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8')

  assert.match(workspaceFile, /apps\/\*/)
  assert.match(workspaceFile, /packages\/\*/)
  assert.ok(existsSync(resolve(repoRoot, 'tooling/tsconfig/base.json')))
  assert.ok(existsSync(resolve(repoRoot, 'tooling/eslint/base.mjs')))
  assert.ok(existsSync(resolve(repoRoot, 'tooling/prettier/base.cjs')))
})

test('US-001 exposes root workspace build, lint, and typecheck commands', () => {
  const rootPackage = readJson('package.json')
  const scripts = rootPackage.scripts as Record<string, string>

  assert.equal(scripts.build, 'pnpm -r run build')
  assert.equal(scripts.lint, 'pnpm run lint:root && pnpm -r run lint')
  assert.equal(scripts.typecheck, 'pnpm run typecheck:root && pnpm -r run typecheck')
})

test('US-001 gives each first-party app and package TypeScript build scripts', () => {
  for (const workspacePackage of workspacePackages) {
    const packageJson = readJson(`${workspacePackage.path}/package.json`)
    const tsconfig = readJson(`${workspacePackage.path}/tsconfig.json`)
    const scripts = packageJson.scripts as Record<string, string>

    assert.equal(scripts.build, 'tsc -p tsconfig.json', `${workspacePackage.path} is missing a TypeScript build script`)
    assert.equal(
      scripts.typecheck,
      'tsc -p tsconfig.json --noEmit',
      `${workspacePackage.path} is missing a TypeScript typecheck script`,
    )
    assert.equal(
      tsconfig.extends,
      `../../tooling/tsconfig/${workspacePackage.config}.json`,
      `${workspacePackage.path} should extend the centralized tsconfig`,
    )
    assert.ok(existsSync(resolve(repoRoot, workspacePackage.path, 'src/index.ts')))
  }
})
