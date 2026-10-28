---
name: conventions
description: Survey a repo's written rules and the existing code around the files about to change, and return a short conventions brief to write to. Read-only. Use before writing code in any repo ("what are the conventions here", "/conventions <area>", and automatically as step 2 of the session workflow), and from pre-review when no brief exists.
---

# Conventions brief

Goal: new code should look like it was written by whoever wrote the code next to it. Produce a brief the author follows and the reviewer checks against. Read-only: edit nothing, run no builds or tests.

Run as a subagent (Agent tool, `general-purpose`, cwd = the worktree) so the survey does not fill the author's context:

```
Read ~/.claude/skills/conventions/SKILL.md and follow it for the git worktree at <absolute path>.
The change will touch: <files, directories, or feature area>. Read-only.
Reply with the brief only.
```

## 1. Written rules (always)

Read, in this order, and treat every rule as binding: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `BUGBOT.md`, `.github/pull_request_template.md`, nested `AGENTS.md` or `README.md` under the target directories, lint and formatter config (`eslint`, `biome`, `prettier`, `golangci`, `ruff`), `tsconfig` path aliases, and the `package.json` scripts. Note generated-code globs and anything marked do-not-edit.

## 2. Neighboring code (the part rules miss)

Rules describe intent; the code shows the actual house style. For the area being changed:

- Open the 3 to 5 closest existing files of the same kind (sibling component, resolver, command, model, hook, test). Prefer files touched in the last 90 days (`git log --since=90.days --name-only -- <dir>`).
- Find one recently merged PR that did something similar (`gh pr list --state merged --search "<keyword>" --limit 5`) and skim its diff for the shape reviewers accepted.
- Record how they do: file and folder layout, naming (files, exports, types, constants, test names), export style, import grouping, state and data access (which store, loader, client, or helper is used), error handling and logging, validation, async patterns, UI primitives and styling, copy tone, and the test pattern (framework, mocks, what is asserted).
- Note existing helpers, utils, stores, constants, and components the change should reuse instead of re-creating. Give paths.

## 3. Output

Under 300 words, concrete, every claim backed by a path. Shape:

```markdown
## Conventions for <repo> / <area>

**Follow these files:** `path/a.ts` (why), `path/b.test.ts` (why), merged PR #n (why).

**Layout and naming:** ...
**Exports and imports:** ...
**Data, state, errors:** ...
**UI and copy:** ... (omit if not UI)
**Tests:** ...
**Reuse, do not re-create:** `path` for X, `path` for Y.
**Rules from AGENTS.md etc. most likely to be missed:** ...
**Do not:** 2 to 4 anti-patterns seen in review on this repo.
```

Skip sections with nothing to say. If the written rules and the neighboring code disagree, say so and follow the written rule.
