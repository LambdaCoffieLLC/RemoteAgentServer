import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

type PackageJson = {
  name?: string
  scripts?: Record<string, string>
}

const repoRoot = resolve(import.meta.dirname, '..')
const expectedWorkspaces = [
  'apps/server',
  'apps/web',
  'apps/mobile',
  'apps/desktop',
  'packages/auth',
  'packages/ports',
  'packages/protocol',
  'packages/providers',
  'packages/runtime',
  'packages/sessions',
  'packages/ui',
]

function readText(relativePath: string) {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

function readJson<T>(relativePath: string) {
  return JSON.parse(readText(relativePath)) as T
}

test('root commands cover the full monorepo workflow', () => {
  const packageJson = readJson<PackageJson>('package.json')

  assert.equal(packageJson.scripts?.build, 'pnpm -r --filter "@remote-agent-server/*" build')
  assert.equal(packageJson.scripts?.lint, 'pnpm run lint:repo && pnpm -r --filter "@remote-agent-server/*" lint')
  assert.equal(
    packageJson.scripts?.typecheck,
    'pnpm run typecheck:repo && pnpm -r --filter "@remote-agent-server/*" typecheck',
  )
  assert.equal(packageJson.scripts?.test, 'pnpm run test:repo && pnpm run test:ralph')
  assert.equal(packageJson.scripts?.verify, 'pnpm lint && pnpm build && pnpm typecheck && pnpm test')
  assert.equal(packageJson.scripts?.verifyRalph, undefined)
  assert.equal(packageJson.scripts?.['verify:ralph'], 'pnpm verify')
})

test('pnpm workspace configuration includes all first-party apps and packages', () => {
  const workspaceConfig = readText('pnpm-workspace.yaml')

  assert.match(workspaceConfig, /apps\/\*/)
  assert.match(workspaceConfig, /packages\/\*/)
})

test('workspace packages extend the centralized TypeScript config and expose build scripts', () => {
  for (const workspacePath of expectedWorkspaces) {
    const packageJsonPath = `${workspacePath}/package.json`
    const tsconfigPath = `${workspacePath}/tsconfig.json`
    const sourceEntryPath = `${workspacePath}/src/index.ts`

    assert.equal(existsSync(join(repoRoot, packageJsonPath)), true, `${packageJsonPath} should exist`)
    assert.equal(existsSync(join(repoRoot, tsconfigPath)), true, `${tsconfigPath} should exist`)
    assert.equal(existsSync(join(repoRoot, sourceEntryPath)), true, `${sourceEntryPath} should exist`)

    const packageJson = readJson<PackageJson>(packageJsonPath)
    const tsconfig = readText(tsconfigPath)
    const expectedBuildScript =
      workspacePath === 'apps/web'
        ? 'tsc -p tsconfig.lib.json && tsc -p tsconfig.json --noEmit && vite build'
        : 'tsc -p tsconfig.json'
    const expectedLintScript =
      workspacePath === 'apps/mobile'
        ? 'eslint App.tsx index.ts src --ext .ts,.tsx'
        : 'eslint src --ext .ts'
    const expectedTypecheckScript =
      workspacePath === 'apps/web'
        ? 'tsc -p tsconfig.json --noEmit'
        : 'tsc -p tsconfig.json --noEmit'

    assert.match(packageJson.name ?? '', /^@remote-agent-server\//)
    assert.equal(packageJson.scripts?.build, expectedBuildScript)
    assert.equal(packageJson.scripts?.lint, expectedLintScript)
    assert.equal(packageJson.scripts?.typecheck, expectedTypecheckScript)
    assert.match(tsconfig, /\.\.\/\.\.\/tsconfig\.package\.json/)
  }
})

test('README documents the root verification flow, test ownership, and test scope', () => {
  const readme = readText('README.md')

  for (const command of ['pnpm install', 'pnpm build', 'pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm verify']) {
    assert.match(readme, new RegExp(command.replace(' ', '\\s+')))
  }

  assert.match(readme, /local/i)
  assert.match(readme, /CI/)
  assert.match(readme, /\.github\/workflows\/verify\.yml/)
  assert.match(readme, /Product Test Coverage/)
  assert.match(readme, /unit/i)
  assert.match(readme, /integration/i)
  assert.match(readme, /smoke/i)
  assert.match(readme, /product-owned/i)
  assert.match(readme, /\.agents\/ralph\/tests/)
})

test('README is an operator and contributor entry point with linked deeper docs', () => {
  const readme = readText('README.md')

  for (const section of [
    'RemoteAgentServer',
    'Quickstart',
    'MVP Smoke Test',
    'Ralph Loop Workflow',
    'Deeper Docs',
    'Repo Layout',
  ]) {
    assert.match(readme, new RegExp(section))
  }

  for (const repoPath of ['apps/server', 'apps/web', 'apps/mobile', 'apps/desktop', 'packages/runtime']) {
    assert.match(readme, new RegExp(repoPath.replace('/', '\\/')))
  }

  assert.match(readme, /pnpm --filter @remote-agent-server\/server dev/)
  assert.match(readme, /pnpm --filter @remote-agent-server\/web dev/)
  assert.match(readme, /pnpm --filter @remote-agent-server\/mobile start/)
  assert.match(readme, /\/api\/hosts/)
  assert.match(readme, /\/api\/workspaces/)
  assert.match(readme, /\/api\/sessions\/session-1\/changes/)
  assert.match(readme, /prd\.json/)
  assert.match(readme, /branchName/)
  assert.match(readme, /pnpm verify:ralph/)
  assert.match(readme, /pnpm ralph/)
  assert.match(readme, /docs\/runtime-install\.md/)
  assert.match(readme, /docs\/architecture\.md/)
  assert.match(readme, /docs\/provider-setup\.md/)
  assert.match(readme, /docs\/security\.md/)

  for (const docPath of [
    'docs/runtime-install.md',
    'docs/architecture.md',
    'docs/provider-setup.md',
    'docs/security.md',
  ]) {
    assert.equal(existsSync(join(repoRoot, docPath)), true, `${docPath} should exist`)
  }
})
