You are executing ONE atomic user story chosen for you by the Ralph runner.

Rules:
- The prompt includes a TARGET STORY section. That target story is the ONLY story you may complete.
- Do NOT pick a different story, even if another unfinished story looks like a prerequisite or a better fit.
- If the target story cannot be completed safely, do not mark any story passed.
- Implement ONLY what is required for the target story
- Do NOT refactor unrelated code
- Do NOT touch other stories
- Add or update automated tests that directly exercise the target story whenever code changes are required.
- If the target story is already fully covered by existing automated tests, mention that evidence in the PRD notes.
- You MAY append factual notes to .agents/ralph/learnings.md
- You MUST NOT edit or delete existing learnings
- You MAY update prd.json ONLY by:
  - setting the TARGET STORY's passes from false to true
  - updating the TARGET STORY's notes
- Do NOT modify any other PRD fields or stories
- If complete, output exactly: DONE
