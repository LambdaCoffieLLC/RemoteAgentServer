import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const electronPackagePath = require.resolve('electron/package.json')
const electronPackageRoot = dirname(electronPackagePath)
const electronPathFile = join(electronPackageRoot, 'path.txt')

if (!existsSync(electronPathFile)) {
  const installScriptPath = join(electronPackageRoot, 'install.js')
  const result = spawnSync(process.execPath, [installScriptPath], {
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
