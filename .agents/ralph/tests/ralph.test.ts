import test from 'node:test'
import assert from 'node:assert/strict'

import { buildExecutionPrompt, buildPlanPrompt, buildPrompt, validatePrdChanges } from '../ralph.js'
import type { Prd } from '../ralph.js'

test('buildPrompt injects rules, prd, and learnings', () => {
  const targetStory = { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: [], priority: 1 }
  const prompt = buildPrompt(
    {
      project: 'RemoteAgentServer',
      branchName: 'main',
      userStories: [targetStory],
    },
    'Existing learning',
    'Follow the rules.',
    targetStory,
  )

  assert.match(prompt, /Follow the rules\./)
  assert.match(prompt, /RemoteAgentServer/)
  assert.match(prompt, /Existing learning/)
  assert.match(prompt, /TARGET STORY/)
})

test('buildPlanPrompt makes the planning phase read-only', () => {
  const targetStory = { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: [], priority: 1 }
  const prompt = buildPlanPrompt(
    {
      project: 'RemoteAgentServer',
      branchName: 'main',
      userStories: [targetStory],
    },
    'Existing learning',
    'Follow the rules.',
    targetStory,
  )

  assert.match(prompt, /planning phase only/i)
  assert.match(prompt, /Do not modify files/i)
  assert.match(prompt, /files you expect to create or edit/i)
})

test('buildExecutionPrompt injects the saved implementation plan', () => {
  const targetStory = { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: [], priority: 1 }
  const prompt = buildExecutionPrompt(
    {
      project: 'RemoteAgentServer',
      branchName: 'main',
      userStories: [targetStory],
    },
    'Existing learning',
    'Follow the rules.',
    targetStory,
    '- edit apps/web/src/main.tsx\n- update tests/web-client.test.ts',
  )

  assert.match(prompt, /IMPLEMENTATION PLAN/)
  assert.match(prompt, /apps\/web\/src\/main\.tsx/)
  assert.match(prompt, /You have already completed a planning pass/i)
})

test('validatePrdChanges allows one story to move to passed with notes', () => {
  const beforePrd: Prd = {
    project: 'RemoteAgentServer',
    branchName: 'main',
    userStories: [
      { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: [], priority: 1 },
      { id: 'US-002', title: 'Story 2', description: 'Desc', acceptanceCriteria: [], priority: 2 },
    ],
  }

  const afterPrd = {
    ...beforePrd,
    userStories: [
      {
        ...beforePrd.userStories[0]!,
        passes: true,
        notes: 'Implemented.',
      },
      beforePrd.userStories[1]!,
    ],
  }

  const changedStory = validatePrdChanges(beforePrd, afterPrd)
  assert.equal(changedStory?.id, 'US-001')
})

test('validatePrdChanges rejects marking a different story than the expected target', () => {
  const beforePrd: Prd = {
    project: 'RemoteAgentServer',
    branchName: 'main',
    userStories: [
      { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: [], priority: 1, passes: false },
      { id: 'US-002', title: 'Story 2', description: 'Desc', acceptanceCriteria: [], priority: 2, passes: false },
    ],
  }

  const afterPrd = {
    ...beforePrd,
    userStories: [
      beforePrd.userStories[0]!,
      {
        ...beforePrd.userStories[1]!,
        passes: true,
        notes: 'Implemented.',
      },
    ],
  }

  assert.throws(
    () => validatePrdChanges(beforePrd, afterPrd, 'US-001'),
    /Expected PRD update for US-001, got US-002 instead/,
  )
})

test('validatePrdChanges rejects unrelated top-level edits', () => {
  const beforePrd = {
    project: 'RemoteAgentServer',
    branchName: 'main',
    userStories: [{ id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: [], priority: 1 }],
  }

  const afterPrd = {
    ...beforePrd,
    project: 'Different',
  }

  assert.throws(() => validatePrdChanges(beforePrd, afterPrd), /prd\.json field changed/)
})
