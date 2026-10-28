---
name: pre-review
description: Pre-PR self-review of the current branch against origin/main using the same rubric and approval gate as the pr-review skill, so the PR passes round 1. Posts nothing to GitHub and edits nothing. Prints findings with file:line, simplification opportunities, and the gate line. Use before opening or updating a PR ("pre-review this branch", "/pre-review", "is this ready for a PR", "would the watcher approve this").
---

# Pre-review (self-review before the PR)

Review the current branch the way the `pr-review` skill will review the PR, so the author fixes things before anyone else sees them. Same bar: a staff engineer who owns this code long term. Read-only: never edit files, never post to GitHub, never run builds or tests.

## 0. Fresh context, or stop

This skill only works from a context that did not write the code. Same-session review shares the author's blind spots. If this session has edited any of the files in the diff, do not review here. Run the review as a subagent with fresh context instead (Agent tool, `general-purpose`, cwd set to this worktree) with this prompt, then relay its report verbatim and fix what it found:

```
Read ~/.claude/skills/pre-review/SKILL.md and follow it exactly for the git worktree at <absolute path>.
You did not write this code, so section 0 passes. Read-only: do not edit files, post to GitHub, or run builds or tests.
You cannot launch agents, so skip the section 3 fan-out and do the three passes yourself.
Reply with the section 6 report only.
```

If the Agent tool is not available, say so and stop with: "Start a new session in this worktree and run `/pre-review` there."

## 1. Gather

```bash
git fetch origin --quiet
BASE=$(git merge-base HEAD origin/main)
git diff --stat $BASE...HEAD
git diff $BASE...HEAD > /tmp/pre-review.diff
git status --porcelain            # uncommitted changes count too; include them
git log --oneline $BASE..HEAD
```

Then read the repo's review rules: `CLAUDE.md`, `AGENTS.md`, `BUGBOT.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`, nested `AGENTS.md` under changed paths, lint config. Every rule there is a review rule. Note generated-code and "do not review" globs.

If the diff is empty, say so and stop.

## 2. Read the whole diff yourself

Read every non-generated changed file in full with line numbers (`cat -n`). You need exact new-file lines. Keep a running list of observations in the scratchpad using the finding shape from section 5.

## 3. Fan out (over ~300 changed lines)

Launch these in parallel with the diff path, the repo rules, and the instruction: read-only, quote exact code, give new-file line numbers, prefer few well-evidenced findings, end with "Verified clean" and "Not checked" lists.

1. **Security and correctness**: untrusted content rendering, authz vs server rules, persisted state growth, polling and cache policy, date/timezone math, mutation flows (refetch, optimistic updates, double submit, error paths), error handling and logging, injection, secrets.
2. **Duplication, simplification, over-engineering**: duplication inside the diff and with existing helpers in the repo, exports nobody imports, abstractions with one call site, config for two values, new dependencies that a few lines would replace, components or functions over 200 lines, speculative generality ("might need later"), comments that restate code, TODOs without tickets.
3. **Tests, conventions, UX**: what each test file covers and misses (error paths, mappers, stores, timezone-dependent dates, tautological tests), convention drift against both the repo rules and the neighboring code (run the `conventions` skill for the touched area if the author has no brief, then compare: layout, naming, exports, reused helpers vs re-created ones), accessibility of new UI, copy quality. Convention drift that a reviewer on this repo has flagged before is a Low, not a Nit.

Skip the agents for small diffs, or when you are the subagent, and do the three passes yourself.

## 4. Verify before you report

For every finding: open the file, confirm the quoted code and line at HEAD, confirm the failure scenario given how the code is called (grep call sites), merge duplicates, drop anything that depends on code nobody opened, downgrade things the repo already does the same way elsewhere to convention notes. Then re-read your own notes and add what the agents missed.

## 5. Severity and gate

Use the `pr-review` rubric exactly:

| Severity | Meaning |
|---|---|
| **Critical** | Security hole, data loss, outage, breaks every user. |
| **High** | Definite bug a real user or operator hits, or a false claim the PR body would make. |
| **Medium** | Likely bug, design flaw that costs real time, two sources of truth, missing tests on a critical path. |
| **Low** | Minor bug, robustness, or simplification with clear payoff. |
| **Nit** | Style, naming, comments, copy. |

```
approve = Critical == 0 and High == 0 and (Medium + Low) < 10
```

Nits never count. A CI check you can predict will fail counts as High.

## 6. Output (to the user, nothing posted)

```markdown
## Pre-review of <branch> vs origin/main (<n> files, +<a>/-<d>)

**Gate:** <C> Critical, <H> High, <M+L> Medium+Low → <would pass | would not pass>.

### Findings
#### Critical / High / Medium / Low
- **<title>** — `path:line`. <What, why it matters, concrete fix in 2 to 3 sentences.>
#### Nits
- `path:line` <one line>

### Simplification opportunities
<Ranked. Each with estimated lines removed. Call out over-engineering plainly: one-call-site abstractions, config for two values, new deps, speculative generality.>

### PR description checklist
<Claims the PR body must make and must be true: behaviors, routes, permissions, tests run, what is deliberately not in this PR.>

### Verified clean
<What you checked and found fine.>

### Next
<One of:
"Fix the N items above, then rerun /pre-review in a fresh context." (any Critical/High/Medium/Low)
"Fix the nits, then open the draft PR." (nits only)
"No findings. Open the draft PR." (nothing)>
```

Keep it under ~1,000 words. Evidence goes in the finding lines, not in prose.
