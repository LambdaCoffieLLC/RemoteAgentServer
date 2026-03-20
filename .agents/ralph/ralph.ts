import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Story = Record<string, unknown>
export type Prd = {
  project: string
  branchName: string
  userStories: Story[]
  [key: string]: unknown
}

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = dirname(scriptPath)
const repoRoot = resolve(scriptDir, '../..')
const prdFile = resolve(repoRoot, 'prd.json')
const learningsFile = resolve(scriptDir, 'learnings.md')
const promptRulesFile = resolve(scriptDir, 'CODEX.md')
const lastStoryFile = resolve(scriptDir, '.last-story')
const logsDir = resolve(scriptDir, 'logs')
const latestRunFile = resolve(scriptDir, 'latest-run.json')
const verificationDir = resolve(scriptDir, 'verification')
const plansDir = resolve(scriptDir, 'plans')

const maxIterations = Number(process.env.RALPH_MAX_ITERATIONS ?? '5')
const testCommand = (process.env.RALPH_VERIFY_COMMAND ?? 'pnpm verify:ralph').trim()
const codexSandbox = process.env.RALPH_CODEX_SANDBOX ?? 'workspace-write'
const codexBypassEnabled = process.env.RALPH_CODEX_BYPASS === 'true'
const codexSearchEnabled = process.env.RALPH_CODEX_SEARCH === 'true'
const autoCleanEnabled = process.env.RALPH_AUTO_CLEAN === 'true'
const planFirstEnabled = process.env.RALPH_PLAN_FIRST !== 'false'
const planSandbox = process.env.RALPH_PLAN_SANDBOX ?? 'read-only'
const missing = Symbol('missing')
const runStamp = new Date().toISOString().replace(/[:.]/g, '-')
const cleanupTargets = [
  '.agents/ralph/latest-run.json',
  '.agents/ralph/logs',
  '.agents/ralph/plans',
  '.agents/ralph/verification',
  'apps',
  'packages',
] as const

type LogFiles = {
  scope: string
  eventLogFile: string
  runLogFile: string
  lastMessageFile: string
}

type TestSignalSummary = {
  testFileCount: number
  testCaseCount: number
}

type VerificationArtifact = {
  runStamp: string
  attempt: number
  expectedStoryId: string
  expectedStoryTitle: string
  selectedStoryId: string | null
  selectedStoryTitle: string | null
  matchedExpectedStory: boolean
  status:
    | 'planning_failed'
    | 'planning_modified_files'
    | 'success'
    | 'codex_not_done'
    | 'verification_failed'
    | 'no_story_updated'
    | 'wrong_story_updated'
    | 'story_not_marked_passed'
    | 'invalid_prd_change'
  verifyCommand: string
  doneTokenSeen: boolean
  verificationPassed: boolean
  changedFiles: string[]
  changedTestFiles: string[]
  beforeTests: {
    fileCount: number
    caseCount: number
  }
  afterTests: {
    fileCount: number
    caseCount: number
  }
  logs: {
    eventLogFile: string
    runLogFile: string
    lastMessageFile: string
  }
  planning?: {
    enabled: boolean
    sandbox: string | null
    planFile: string | null
  }
  error?: string
}

const logFilesByScope = new Map<string, LogFiles>()
let currentLogScope = '_session'

function sanitizeLogScope(scope: string) {
  return scope.replace(/[^A-Za-z0-9._-]/g, '_')
}

function setLogScope(scope: string) {
  currentLogScope = scope
}

function writeLatestRunPointer(logFiles: LogFiles) {
  writeFileSync(
    latestRunFile,
    JSON.stringify(
      {
        runStamp,
        scope: logFiles.scope,
        eventLogFile: logFiles.eventLogFile,
        runLogFile: logFiles.runLogFile,
        lastMessageFile: logFiles.lastMessageFile,
      },
      null,
      2,
    ) + '\n',
  )
}

function getLogFiles(): LogFiles {
  const existing = logFilesByScope.get(currentLogScope)
  if (existing) {
    mkdirSync(dirname(existing.eventLogFile), { recursive: true })
    writeLatestRunPointer(existing)
    return existing
  }

  mkdirSync(logsDir, { recursive: true })
  const scopeDir = resolve(logsDir, sanitizeLogScope(currentLogScope))
  mkdirSync(scopeDir, { recursive: true })

  const logFiles = {
    scope: currentLogScope,
    eventLogFile: resolve(scopeDir, `${runStamp}-events.log`),
    runLogFile: resolve(scopeDir, `${runStamp}-run.log`),
    lastMessageFile: resolve(scopeDir, `${runStamp}-last-message.txt`),
  }
  logFilesByScope.set(currentLogScope, logFiles)
  writeLatestRunPointer(logFiles)

  return logFiles
}

function logEvent(message: string) {
  const { eventLogFile } = getLogFiles()
  console.log(`[ralph] ${message}`)
  appendFileSync(eventLogFile, `[${new Date().toISOString()}] ${message}\n`)
}

function run(command: string, args: string[], cwd = repoRoot, input?: string) {
  return spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' },
  })
}

async function runStreaming(
  command: string,
  args: string[],
  {
    cwd = repoRoot,
    input,
    logFile,
  }: {
    cwd?: string
    input?: string
    logFile: string
  },
): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' },
      stdio: 'pipe',
    })
    const logStream = createWriteStream(logFile, { flags: 'a' })

    const appendChunk = (chunk: string | Buffer) => {
      logStream.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    }

    child.stdout?.on('data', appendChunk)
    child.stderr?.on('data', appendChunk)

    child.on('error', (error) => {
      logStream.end(() => rejectPromise(error))
    })

    child.on('close', (status, signal) => {
      logStream.end(() => resolvePromise({ status, signal }))
    })

    if (input) {
      child.stdin?.write(input)
    }
    child.stdin?.end()
  })
}

function git(args: string[]) {
  return run('git', args)
}

function ensureCleanRepo() {
  const status = git(['status', '--porcelain'])
  if ((status.stdout ?? '').trim()) {
    throw new Error('Repo is dirty. Commit or stash changes before running Ralph.')
  }
}

function getIgnoredCleanupCandidates() {
  const result = git(['status', '--ignored', '--porcelain', '--', ...cleanupTargets])
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('!! ') || line.startsWith('?? '))
    .map((line) => line.slice(3))
}

function cleanGeneratedArtifacts() {
  const result = git(['clean', '-fdx', '--', ...cleanupTargets])
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Failed to clean generated Ralph artifacts.')
  }
  logFilesByScope.clear()
}

function maybeHandleGeneratedArtifacts() {
  const candidates = getIgnoredCleanupCandidates()
  if (candidates.length === 0) {
    return
  }

  if (autoCleanEnabled) {
    cleanGeneratedArtifacts()
    logEvent(`Pre-cleaned generated artifacts: ${cleanupTargets.join(', ')}`)
    return
  }

  logEvent(
    `Detected ignored generated artifacts (${candidates.join(', ')}). Run "pnpm ralph:clean" before a fresh run, or set RALPH_AUTO_CLEAN=true to let Ralph clean them automatically.`,
  )
}

function checkoutBranch(branch: string) {
  const exists = (git(['branch', '--list', branch]).stdout ?? '').trim()
  const result = exists ? git(['checkout', branch]) : git(['checkout', '-b', branch])
  if (result.status !== 0) {
    throw new Error(result.stderr || `Failed to checkout branch ${branch}`)
  }
}

function rollback() {
  git(['reset', '--hard', 'HEAD'])
  git(['clean', '-fd'])
}

function commitStory(story: Story) {
  git(['add', '.'])
  const id = String(story.id)
  const title = String(story.title)
  return git(['commit', '-m', `${id}: ${title}`]).status === 0
}

function hashText(text: string) {
  return Buffer.from(text, 'utf8').toString('base64')
}

function readLearnings() {
  return existsSync(learningsFile) ? readFileSync(learningsFile, 'utf8') : ''
}

function validateAppendOnly(beforeText: string) {
  if (!existsSync(learningsFile)) {
    throw new Error('learnings.md was deleted.')
  }

  const afterText = readLearnings()
  if (hashText(beforeText) !== hashText(afterText) && !afterText.startsWith(beforeText)) {
    throw new Error('learnings.md was modified non-append-only.')
  }
}

function loadPrd(): Prd {
  return JSON.parse(readFileSync(prdFile, 'utf8')) as Prd
}

function getStoryId(story: Story) {
  return String(story.id)
}

function getStoryTitle(story: Story) {
  return String(story.title)
}

function isTestFile(file: string) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
}

function walkFiles(root: string, base = root): string[] {
  if (!existsSync(root)) {
    return []
  }

  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(root, entry.name)
    const repoRelative = relative(base, fullPath)
    if (
      entry.name === '.git' ||
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      repoRelative.startsWith('.agents/ralph/logs/') ||
      repoRelative.startsWith('.agents/ralph/verification/')
    ) {
      return []
    }

    if (entry.isDirectory()) {
      return walkFiles(fullPath, base)
    }

    if (!entry.isFile()) {
      return []
    }

    return [repoRelative]
  })
}

function collectTestSignals(): TestSignalSummary {
  const repoFiles = walkFiles(repoRoot)
  const testFiles = repoFiles.filter(isTestFile)
  const testCaseCount = testFiles.reduce((count, file) => {
    const contents = readFileSync(resolve(repoRoot, file), 'utf8')
    const matches = contents.match(/\b(?:test|it)\s*\(/g)
    return count + (matches?.length ?? 0)
  }, 0)

  return {
    testFileCount: testFiles.length,
    testCaseCount,
  }
}

function getChangedFiles() {
  const tracked = (git(['diff', '--name-only', '--relative', 'HEAD']).stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const untracked = (git(['ls-files', '--others', '--exclude-standard']).stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return Array.from(new Set([...tracked, ...untracked])).sort()
}

function writeVerificationArtifact(artifact: VerificationArtifact) {
  const storyDir = resolve(verificationDir, sanitizeLogScope(artifact.expectedStoryId))
  mkdirSync(storyDir, { recursive: true })
  const artifactFile = resolve(storyDir, `${runStamp}-attempt-${String(artifact.attempt).padStart(2, '0')}.json`)
  writeFileSync(artifactFile, JSON.stringify(artifact, null, 2) + '\n')
}

export function buildPrompt(prd: Prd, learnings: string, promptRules: string, targetStory: Story) {
  return buildExecutionPrompt(prd, learnings, promptRules, targetStory, '')
}

export function buildPlanPrompt(prd: Prd, learnings: string, promptRules: string, targetStory: Story) {
  return `${promptRules.trim()}

You are in the planning phase only.
Do not modify files, do not update prd.json, and do not append to learnings.md.
Inspect the repo and return a concise implementation plan for the target story.
The plan must include:
- the files you expect to create or edit
- the tests or verification you will add or update
- the main implementation steps
- any likely risks or dependencies

--- TARGET STORY (THE ONLY STORY YOU MAY COMPLETE) ---
${JSON.stringify(targetStory, null, 2)}

--- PRD (READ-ONLY except allowed passes/notes for one story) ---
${JSON.stringify(prd, null, 2)}

--- EXISTING LEARNINGS (READ-ONLY) ---
${learnings}`
}

export function buildExecutionPrompt(
  prd: Prd,
  learnings: string,
  promptRules: string,
  targetStory: Story,
  implementationPlan: string,
) {
  return `${promptRules.trim()}

You have already completed a planning pass for this story.
Use the implementation plan below as the baseline for execution. You may refine it while working, but you must still satisfy the target story exactly.

--- IMPLEMENTATION PLAN ---
${implementationPlan.trim() || 'No plan text was captured.'}

--- TARGET STORY (THE ONLY STORY YOU MAY COMPLETE) ---
${JSON.stringify(targetStory, null, 2)}

--- PRD (READ-ONLY except allowed passes/notes for one story) ---
${JSON.stringify(prd, null, 2)}

--- EXISTING LEARNINGS (READ-ONLY) ---
${learnings}`
}

function getField<T>(value: Record<string, unknown>, key: string): T | typeof missing {
  return Object.prototype.hasOwnProperty.call(value, key) ? (value[key] as T) : missing
}

export function validatePrdChanges(beforePrd: Prd, afterPrd: Prd, expectedStoryId?: string): Story | null {
  const beforeKeys = Object.keys(beforePrd).sort()
  const afterKeys = Object.keys(afterPrd).sort()
  if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) {
    throw new Error('prd.json top-level keys changed.')
  }

  for (const key of beforeKeys) {
    if (key === 'userStories') continue
    if (JSON.stringify(beforePrd[key]) !== JSON.stringify(afterPrd[key])) {
      throw new Error(`prd.json field changed: ${key}`)
    }
  }

  if (beforePrd.userStories.length !== afterPrd.userStories.length) {
    throw new Error('prd.json userStories length changed.')
  }

  let changedStory: Story | null = null

  beforePrd.userStories.forEach((beforeStory, index) => {
    const afterStory = afterPrd.userStories[index]
    if (!afterStory) {
      throw new Error('prd.json userStories length changed.')
    }

    if (beforeStory.id !== afterStory.id) {
      throw new Error('prd.json userStories were reordered or IDs changed.')
    }

    const stripMutableFields = (story: Story) =>
      Object.fromEntries(Object.entries(story).filter(([key]) => key !== 'passes' && key !== 'notes'))

    if (JSON.stringify(stripMutableFields(beforeStory)) !== JSON.stringify(stripMutableFields(afterStory))) {
      throw new Error(`prd.json story fields changed for ${String(beforeStory.id)}.`)
    }

    let storyChanged = false

    const passesBefore = getField<boolean>(beforeStory, 'passes')
    const passesAfter = getField<boolean>(afterStory, 'passes')

    if (passesAfter !== missing && typeof passesAfter !== 'boolean') {
      throw new Error(`prd.json passes is not boolean for ${String(beforeStory.id)}.`)
    }

    if (passesBefore === missing && passesAfter === missing) {
      void 0
    } else if (passesBefore === missing && passesAfter === true) {
      storyChanged = true
    } else if (passesBefore === false && passesAfter === true) {
      storyChanged = true
    } else if (passesBefore === passesAfter) {
      void 0
    } else {
      throw new Error(`prd.json passes changed illegally for ${String(beforeStory.id)}.`)
    }

    const notesBefore = getField<unknown>(beforeStory, 'notes')
    const notesAfter = getField<unknown>(afterStory, 'notes')

    if (notesBefore === missing && notesAfter === missing) {
      void 0
    } else if (notesBefore === missing && notesAfter !== missing) {
      storyChanged = true
    } else if (notesBefore !== missing && notesAfter === missing) {
      throw new Error(`prd.json notes removed for ${String(beforeStory.id)}.`)
    } else if (JSON.stringify(notesBefore) !== JSON.stringify(notesAfter)) {
      storyChanged = true
    }

    if (storyChanged) {
      if (passesBefore !== false && passesBefore !== missing) {
        throw new Error(`Selected story must have passes == false for ${String(beforeStory.id)}.`)
      }
      if (changedStory && changedStory.id !== afterStory.id) {
        throw new Error('Multiple stories modified in prd.json.')
      }
      changedStory = afterStory
    }
  })

  const changedStoryId = changedStory ? String(changedStory['id']) : null
  if (expectedStoryId && changedStoryId && changedStoryId !== expectedStoryId) {
    throw new Error(`Expected PRD update for ${expectedStoryId}, got ${changedStoryId} instead.`)
  }

  return changedStory
}

function getPlanFile(storyId: string, attempt: number) {
  const storyDir = resolve(plansDir, sanitizeLogScope(storyId))
  mkdirSync(storyDir, { recursive: true })
  return resolve(storyDir, `${runStamp}-attempt-${String(attempt).padStart(2, '0')}.md`)
}

async function runCodex(
  prompt: string,
  {
    phaseLabel = 'execution',
    sandboxOverride,
    bypassOverride,
  }: {
    phaseLabel?: 'planning' | 'execution'
    sandboxOverride?: string
    bypassOverride?: boolean
  } = {},
) {
  const { runLogFile, lastMessageFile } = getLogFiles()
  const args = ['exec']
  const bypass = bypassOverride ?? codexBypassEnabled
  const sandbox = sandboxOverride ?? codexSandbox
  if (bypass) {
    args.push('--dangerously-bypass-approvals-and-sandbox')
  } else {
    args.push('--sandbox', sandbox)
  }
  args.push('--output-last-message', lastMessageFile)
  if (codexSearchEnabled) {
    args.push('--search')
  }

  logEvent(
    bypass
      ? `Starting codex ${phaseLabel} run with bypass approvals+sandbox`
      : `Starting codex ${phaseLabel} run with sandbox=${sandbox}`,
  )
  writeFileSync(lastMessageFile, '')
  const result = await runStreaming('codex', args, { cwd: repoRoot, input: prompt, logFile: runLogFile })
  if (result.signal) {
    throw new Error(`codex exec terminated by signal ${result.signal}`)
  }
  if (result.status !== 0) {
    throw new Error(`codex exec failed with exit code ${String(result.status)}`)
  }
  return existsSync(lastMessageFile) ? readFileSync(lastMessageFile, 'utf8') : ''
}

async function runVerification() {
  const { runLogFile } = getLogFiles()
  logEvent(`Running verification: ${testCommand}`)
  if (!testCommand) {
    throw new Error('Verification command is empty.')
  }
  const result = await runStreaming('zsh', ['-lc', testCommand], { logFile: runLogFile })
  if (result.signal) {
    throw new Error(`verification command terminated by signal ${result.signal}`)
  }
  return result.status === 0
}

async function runStory(promptRules: string, expectedStory: Story) {
  for (let attempt = 1; attempt <= maxIterations; attempt += 1) {
    logEvent(`Attempt ${attempt}/${maxIterations}`)

    const prdBefore = loadPrd()
    const learningsBefore = readLearnings()
    const beforeTests = collectTestSignals()
    const planFile = planFirstEnabled ? getPlanFile(getStoryId(expectedStory), attempt) : null
    let implementationPlan = ''

    if (planFirstEnabled) {
      const planOutput = await runCodex(buildPlanPrompt(prdBefore, learningsBefore, promptRules, expectedStory), {
        phaseLabel: 'planning',
        sandboxOverride: planSandbox,
        bypassOverride: false,
      })
      const planningChangedFiles = getChangedFiles()
      const prdAfterPlanning = loadPrd()
      const learningsAfterPlanning = readLearnings()

      if (planningChangedFiles.length > 0 || JSON.stringify(prdBefore) !== JSON.stringify(prdAfterPlanning) || learningsBefore !== learningsAfterPlanning) {
        const logFiles = getLogFiles()
        writeVerificationArtifact({
          runStamp,
          attempt,
          expectedStoryId: getStoryId(expectedStory),
          expectedStoryTitle: getStoryTitle(expectedStory),
          selectedStoryId: null,
          selectedStoryTitle: null,
          matchedExpectedStory: false,
          status: 'planning_modified_files',
          verifyCommand: testCommand,
          doneTokenSeen: false,
          verificationPassed: false,
          changedFiles: planningChangedFiles,
          changedTestFiles: planningChangedFiles.filter(isTestFile),
          beforeTests: {
            fileCount: beforeTests.testFileCount,
            caseCount: beforeTests.testCaseCount,
          },
          afterTests: {
            fileCount: beforeTests.testFileCount,
            caseCount: beforeTests.testCaseCount,
          },
          logs: {
            eventLogFile: logFiles.eventLogFile,
            runLogFile: logFiles.runLogFile,
            lastMessageFile: logFiles.lastMessageFile,
          },
          planning: {
            enabled: true,
            sandbox: planSandbox,
            planFile,
          },
          error: 'Planning phase modified the worktree or PRD/learnings state.',
        })
        logEvent('Planning phase modified files or mutable state; rolling back')
        rollback()
        continue
      }

      implementationPlan = planOutput.trim()
      if (!implementationPlan) {
        const logFiles = getLogFiles()
        writeVerificationArtifact({
          runStamp,
          attempt,
          expectedStoryId: getStoryId(expectedStory),
          expectedStoryTitle: getStoryTitle(expectedStory),
          selectedStoryId: null,
          selectedStoryTitle: null,
          matchedExpectedStory: false,
          status: 'planning_failed',
          verifyCommand: testCommand,
          doneTokenSeen: false,
          verificationPassed: false,
          changedFiles: [],
          changedTestFiles: [],
          beforeTests: {
            fileCount: beforeTests.testFileCount,
            caseCount: beforeTests.testCaseCount,
          },
          afterTests: {
            fileCount: beforeTests.testFileCount,
            caseCount: beforeTests.testCaseCount,
          },
          logs: {
            eventLogFile: logFiles.eventLogFile,
            runLogFile: logFiles.runLogFile,
            lastMessageFile: logFiles.lastMessageFile,
          },
          planning: {
            enabled: true,
            sandbox: planSandbox,
            planFile,
          },
          error: 'Planning phase returned an empty plan.',
        })
        logEvent('Planning phase returned an empty plan; rolling back')
        rollback()
        continue
      }

      if (planFile) {
        writeFileSync(planFile, implementationPlan + '\n')
        logEvent(`Saved implementation plan: ${planFile}`)
      }
    }

    const output = await runCodex(
      buildExecutionPrompt(prdBefore, learningsBefore, promptRules, expectedStory, implementationPlan),
      { phaseLabel: 'execution' },
    )

    try {
      validateAppendOnly(learningsBefore)
    } catch (error) {
      rollback()
      throw error
    }

    const prdAfter = loadPrd()
    const done = output
      .split('\n')
      .some((line) => line.trim() === 'DONE')
    const changedFiles = getChangedFiles()
    const changedTestFiles = changedFiles.filter(isTestFile)
    const afterTests = collectTestSignals()
    const logFiles = getLogFiles()
    let selectedStory: Story | null = null

    try {
      selectedStory = validatePrdChanges(prdBefore, prdAfter, getStoryId(expectedStory))
    } catch (error) {
      writeVerificationArtifact({
        runStamp,
        attempt,
        expectedStoryId: getStoryId(expectedStory),
        expectedStoryTitle: getStoryTitle(expectedStory),
        selectedStoryId: null,
        selectedStoryTitle: null,
        matchedExpectedStory: false,
        status: 'invalid_prd_change',
        verifyCommand: testCommand,
        doneTokenSeen: done,
        verificationPassed: false,
        changedFiles,
        changedTestFiles,
        beforeTests: {
          fileCount: beforeTests.testFileCount,
          caseCount: beforeTests.testCaseCount,
        },
        afterTests: {
          fileCount: afterTests.testFileCount,
          caseCount: afterTests.testCaseCount,
        },
        logs: {
          eventLogFile: logFiles.eventLogFile,
          runLogFile: logFiles.runLogFile,
          lastMessageFile: logFiles.lastMessageFile,
        },
        planning: {
          enabled: planFirstEnabled,
          sandbox: planFirstEnabled ? planSandbox : null,
          planFile,
        },
        error: error instanceof Error ? error.message : String(error),
      })
      logEvent(`PRD validation failed for ${getStoryId(expectedStory)}; rolling back`)
      rollback()
      continue
    }

    if (!done) {
      writeVerificationArtifact({
        runStamp,
        attempt,
        expectedStoryId: getStoryId(expectedStory),
        expectedStoryTitle: getStoryTitle(expectedStory),
        selectedStoryId: selectedStory ? getStoryId(selectedStory) : null,
        selectedStoryTitle: selectedStory ? getStoryTitle(selectedStory) : null,
        matchedExpectedStory: selectedStory ? getStoryId(selectedStory) === getStoryId(expectedStory) : false,
        status: 'codex_not_done',
        verifyCommand: testCommand,
        doneTokenSeen: false,
        verificationPassed: false,
        changedFiles,
        changedTestFiles,
        beforeTests: {
          fileCount: beforeTests.testFileCount,
          caseCount: beforeTests.testCaseCount,
        },
        afterTests: {
          fileCount: afterTests.testFileCount,
          caseCount: afterTests.testCaseCount,
        },
        logs: {
          eventLogFile: logFiles.eventLogFile,
          runLogFile: logFiles.runLogFile,
          lastMessageFile: logFiles.lastMessageFile,
        },
        planning: {
          enabled: planFirstEnabled,
          sandbox: planFirstEnabled ? planSandbox : null,
          planFile,
        },
      })
      logEvent('Codex did not report DONE; rolling back')
      rollback()
      continue
    }

    const verificationPassed = await runVerification()

    if (!verificationPassed) {
      writeVerificationArtifact({
        runStamp,
        attempt,
        expectedStoryId: getStoryId(expectedStory),
        expectedStoryTitle: getStoryTitle(expectedStory),
        selectedStoryId: selectedStory ? getStoryId(selectedStory) : null,
        selectedStoryTitle: selectedStory ? getStoryTitle(selectedStory) : null,
        matchedExpectedStory: selectedStory ? getStoryId(selectedStory) === getStoryId(expectedStory) : false,
        status: 'verification_failed',
        verifyCommand: testCommand,
        doneTokenSeen: true,
        verificationPassed: false,
        changedFiles,
        changedTestFiles,
        beforeTests: {
          fileCount: beforeTests.testFileCount,
          caseCount: beforeTests.testCaseCount,
        },
        afterTests: {
          fileCount: afterTests.testFileCount,
          caseCount: afterTests.testCaseCount,
        },
        logs: {
          eventLogFile: logFiles.eventLogFile,
          runLogFile: logFiles.runLogFile,
          lastMessageFile: logFiles.lastMessageFile,
        },
        planning: {
          enabled: planFirstEnabled,
          sandbox: planFirstEnabled ? planSandbox : null,
          planFile,
        },
      })
      logEvent('Verification failed; rolling back')
      rollback()
      continue
    }

    if (!selectedStory) {
      writeVerificationArtifact({
        runStamp,
        attempt,
        expectedStoryId: getStoryId(expectedStory),
        expectedStoryTitle: getStoryTitle(expectedStory),
        selectedStoryId: null,
        selectedStoryTitle: null,
        matchedExpectedStory: false,
        status: 'no_story_updated',
        verifyCommand: testCommand,
        doneTokenSeen: true,
        verificationPassed: true,
        changedFiles,
        changedTestFiles,
        beforeTests: {
          fileCount: beforeTests.testFileCount,
          caseCount: beforeTests.testCaseCount,
        },
        afterTests: {
          fileCount: afterTests.testFileCount,
          caseCount: afterTests.testCaseCount,
        },
        logs: {
          eventLogFile: logFiles.eventLogFile,
          runLogFile: logFiles.runLogFile,
          lastMessageFile: logFiles.lastMessageFile,
        },
        planning: {
          enabled: planFirstEnabled,
          sandbox: planFirstEnabled ? planSandbox : null,
          planFile,
        },
      })
      logEvent('No story updated in PRD; rolling back')
      rollback()
      continue
    }

    if (getStoryId(selectedStory) !== getStoryId(expectedStory)) {
      writeVerificationArtifact({
        runStamp,
        attempt,
        expectedStoryId: getStoryId(expectedStory),
        expectedStoryTitle: getStoryTitle(expectedStory),
        selectedStoryId: getStoryId(selectedStory),
        selectedStoryTitle: getStoryTitle(selectedStory),
        matchedExpectedStory: false,
        status: 'wrong_story_updated',
        verifyCommand: testCommand,
        doneTokenSeen: true,
        verificationPassed: true,
        changedFiles,
        changedTestFiles,
        beforeTests: {
          fileCount: beforeTests.testFileCount,
          caseCount: beforeTests.testCaseCount,
        },
        afterTests: {
          fileCount: afterTests.testFileCount,
          caseCount: afterTests.testCaseCount,
        },
        logs: {
          eventLogFile: logFiles.eventLogFile,
          runLogFile: logFiles.runLogFile,
          lastMessageFile: logFiles.lastMessageFile,
        },
        planning: {
          enabled: planFirstEnabled,
          sandbox: planFirstEnabled ? planSandbox : null,
          planFile,
        },
      })
      logEvent(`Expected ${getStoryId(expectedStory)} but Codex updated ${getStoryId(selectedStory)}; rolling back`)
      rollback()
      continue
    }

    if (selectedStory['passes'] !== true) {
      writeVerificationArtifact({
        runStamp,
        attempt,
        expectedStoryId: getStoryId(expectedStory),
        expectedStoryTitle: getStoryTitle(expectedStory),
        selectedStoryId: getStoryId(selectedStory),
        selectedStoryTitle: getStoryTitle(selectedStory),
        matchedExpectedStory: true,
        status: 'story_not_marked_passed',
        verifyCommand: testCommand,
        doneTokenSeen: true,
        verificationPassed: true,
        changedFiles,
        changedTestFiles,
        beforeTests: {
          fileCount: beforeTests.testFileCount,
          caseCount: beforeTests.testCaseCount,
        },
        afterTests: {
          fileCount: afterTests.testFileCount,
          caseCount: afterTests.testCaseCount,
        },
        logs: {
          eventLogFile: logFiles.eventLogFile,
          runLogFile: logFiles.runLogFile,
          lastMessageFile: logFiles.lastMessageFile,
        },
        planning: {
          enabled: planFirstEnabled,
          sandbox: planFirstEnabled ? planSandbox : null,
          planFile,
        },
      })
      logEvent(`Story ${String(selectedStory['id'])} was not marked passed; rolling back`)
      rollback()
      continue
    }

    writeVerificationArtifact({
      runStamp,
      attempt,
      expectedStoryId: getStoryId(expectedStory),
      expectedStoryTitle: getStoryTitle(expectedStory),
      selectedStoryId: getStoryId(selectedStory),
      selectedStoryTitle: getStoryTitle(selectedStory),
      matchedExpectedStory: true,
      status: 'success',
      verifyCommand: testCommand,
      doneTokenSeen: true,
      verificationPassed: true,
      changedFiles,
      changedTestFiles,
      beforeTests: {
        fileCount: beforeTests.testFileCount,
        caseCount: beforeTests.testCaseCount,
      },
      afterTests: {
        fileCount: afterTests.testFileCount,
        caseCount: afterTests.testCaseCount,
      },
        logs: {
          eventLogFile: logFiles.eventLogFile,
          runLogFile: logFiles.runLogFile,
          lastMessageFile: logFiles.lastMessageFile,
        },
        planning: {
          enabled: planFirstEnabled,
          sandbox: planFirstEnabled ? planSandbox : null,
          planFile,
        },
      })

    writeFileSync(lastStoryFile, String(selectedStory['id']))
    if (commitStory(selectedStory)) {
      logEvent(`Committed ${String(selectedStory['id'])}`)
      return true
    }

    rollback()
    return false
  }

  return false
}

export async function main() {
  const { eventLogFile, runLogFile } = getLogFiles()
  logEvent(`Repo root: ${repoRoot}`)
  logEvent(`PRD: ${prdFile}`)
  logEvent(`Logs: ${eventLogFile} and ${runLogFile}`)
  logEvent(`Latest run pointer: ${latestRunFile}`)
  logEvent(
    codexBypassEnabled
      ? `Codex config: bypass=true search=${codexSearchEnabled}`
      : `Codex config: sandbox=${codexSandbox} search=${codexSearchEnabled}`,
  )
  logEvent(`Plan-first config: enabled=${planFirstEnabled} sandbox=${planFirstEnabled ? planSandbox : 'disabled'}`)
  maybeHandleGeneratedArtifacts()
  ensureCleanRepo()

  const prd = loadPrd()
  const promptRules = readFileSync(promptRulesFile, 'utf8')

  checkoutBranch(prd.branchName)

  while (true) {
    const currentPrd = loadPrd()
    const pendingStories = currentPrd.userStories.filter((story) => story.passes !== true)
    if (pendingStories.length === 0) {
      logEvent('All stories passed')
      break
    }

    const nextStory = pendingStories
      .slice()
      .sort((left, right) => {
        const leftPriority = Number(left.priority ?? Number.MAX_SAFE_INTEGER)
        const rightPriority = Number(right.priority ?? Number.MAX_SAFE_INTEGER)
        if (leftPriority !== rightPriority) return leftPriority - rightPriority
        return String(left.id).localeCompare(String(right.id))
      })[0]
    if (!nextStory) {
      logEvent('No pending story selected')
      break
    }

    setLogScope(String(nextStory.id))
    const storyLogFiles = getLogFiles()
    logEvent(`Story logs: ${storyLogFiles.eventLogFile} and ${storyLogFiles.runLogFile}`)
    logEvent(`Starting story ${String(nextStory.id)}: ${String(nextStory.title)}`)

    const success = await runStory(promptRules, nextStory)
    if (!success) {
      logEvent('Halting Ralph after failed story attempts')
      break
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    logEvent(`Fatal error: ${message}`)
    console.error(message)
    process.exit(1)
  })
}
