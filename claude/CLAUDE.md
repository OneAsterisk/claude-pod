# Global Preferences

## Scope of Work

- **Only do exactly what is asked.** Nothing more.
- If the user asks a question, answer it — do not also make code changes.
- If the user describes a bug or something unexpected, identify it — do not fix it.
- Do not refactor, clean up, improve, or touch anything beyond the literal request.
- If something feels out of scope, flag it and ask before touching it.

## Testing

- **Never run tests yourself** (no `yarn test`, `yarn jest`, `npm test`, `pytest`, etc.). It doesn't work in this environment — tests hang and leave ghost threads behind. Reason against the code, or ask the user to run them and paste the output.

## Naming

- Always refer to the company as **Runpod**, never "RunPod".

## Git
- Always sign commits with `-S`
- Only push when explicitly asked to
- If asked to commit while on `main`, create a branch first:
  - If working on a Linear issue, use the Linear git branch name
  - Otherwise use the naming scheme `benpapp/small-description`
- Before committing or pushing to any branch, check if that branch has a closed/merged PR (`gh pr list --state merged --head <branch>` or similar). If it does, ask whether to push to that branch anyway or create a new one first.

# Global Preferences

## Scope of Work

- **Only do exactly what is asked.** Nothing more.
- If the user asks a question, answer it — do not also make code changes.
- If the user describes a bug or something unexpected, identify it — do not fix it.
- Do not refactor, clean up, improve, or touch anything beyond the literal request.
- If something feels out of scope, flag it and ask before touching it.

## Testing

- **Never run tests yourself** (no `yarn test`, `yarn jest`, `npm test`, `pytest`, etc.). It doesn't work in this environment — tests hang and leave ghost threads behind. Reason against the code, or ask the user to run them and paste the output.

## Naming

- Always refer to the company as **Runpod**, never "RunPod".

## Git
- Never add a claude co-author to any commits or PRs
- Always sign commits with `-S`
- Only push when explicitly asked to
- If asked to commit while on `main`, create a branch first:
  - If working on a Linear issue, use the Linear git branch name
  - Otherwise use the naming scheme `benpapp/small-description`
- Before committing or pushing to any branch, check if that branch has a closed/merged PR (`gh pr list --state merged --head <branch>` or similar). If it does, ask whether to push to that branch anyway or create a new one first.

## Pull Requests
- Always open PRs as drafts (`gh pr create --draft`). Never open a non-draft PR or mark one ready for review (`gh pr ready`) without explicit permission.
- If a PR has any visual changes, document them in the PR:
  - For UI changes, take before and after screenshots and add them to the PR.
  - For new flows, record a video that shows the flow and add it to the PR.

## Writing Style
- Do not use em dashes. Use commas, periods, or parentheses.
- Avoid filler phrases such as "it is important to note that".
- Avoid marketing language such as "streamlined workflow" or "robust solution".
- Use active voice.
- Be direct.
- Keep sentences under 20 words when practical.
- Prefer concrete names, paths, commands, and examples.
- Explain unfamiliar project-specific terms when first used.
- Avoid repeating the same explanation across documents.
- Use short paragraphs, headings, lists, and tables where they improve scanning.
- Do not describe intent unless the code or repository explicitly establishes it.
- Distinguish verified behavior from recommendations.

## Review Standard

Code should pass the `pr-review` gate on round 1: no Critical or High findings, fewer than 10 Medium plus Low.

### Session workflow (every session that edits code)

1. **Goal first.** Before editing anything, write one line: `Goal: <what done looks like>`. If the request does not say what done looks like, ask one question, then write it. Check every later step against that line.
2. **Write the code.** Smallest change that meets the goal.
3. **Pre-review in a fresh context.** Run `/pre-review` as a subagent (the skill has the prompt) or in a new session in the same worktree. Never review in the context that wrote the code.
4. **Fix every finding** (Critical, High, Medium, Low, and nits that take a line). Then go back to step 3.
5. **Done means a pre-review round with no findings.** Only then open the draft PR. After three rounds that still have findings, stop and show the user what remains instead of looping.

- Prefer the smallest change that works. No abstractions with one call site, no config for two values, no new dependency a few lines would replace, no "might need later" generality.
- Reuse existing helpers, stores, and utils before writing new ones. Two sources of truth is a Medium.
- Every user-facing claim in the PR body must be true at head. Tests cover error paths, not just the happy path.
- Security and correctness first: authz gated the way the server gates it, untrusted content escaped, mutations handle failure and refetch, dates respect timezone.

### Pre-review checklist (what reviewers keep catching)

Reviewers on main-ui, RunPod, and runpodctl keep catching the same things. Run this list against the diff before opening a PR and again before un-drafting. First re-read the repo's `AGENTS.md` style section and check each rule against the diff. Named exports, the `Icon` suffix, `@runpod/ux-components`, and no magic strings were all written there and still reached review.

#### Structure and style (main-ui)

- Named exports only. Name the component file after the component (`CornerPopup/CornerPopup.tsx`) and barrel it through `index.ts`.
- Per component folder: `types.ts` for types and unions, `constants.ts` for numbers and limits, `helpers/` for pure functions. Do not bury these inside a logic file.
- No magic strings for states or kinds. Use an `as const` object with a derived union. Avoid `enum`; enum members do not assign to literal-union props.
- Let TypeScript infer. Write `useState("")` and `useRef("")`, not `useState<string>()` or `useRef<string>("")`.
- One import statement per module, with types inline: `import { useState, type ReactNode } from "react"`. Group all `useRef` declarations together above derived values.
- Reach for `@runpod/ux-components` (`Button`, `Card`, `Link`) before a raw element or `@theme`. Check `USAGE.md` for defaults; `MenuButton` renders a kebab icon unless `icon={null}`.
- Pass a whole payload object down instead of spreading its fields as props.
- `text-xs` is under 12px. Use `text-sm` unless there is a stated reason.
- Declare every package you import directly in `package.json`. Pick ranges that merge with the existing lockfile entries so only one copy resolves.
- Strip leftovers from removed systems (MUI `sx` props) and keep unrelated changes out of the PR (speculative `testID`s, formatter-only churn).
- Icon-only buttons need an `aria-label`. Do not wrap an accordion in a second `role="region"`.

#### Correctness patterns reviewers catch

- Async inputs resolve at different times: PostHog flags are sync from cache, `useMeasure` and `useMyself` are not. Gate visibility on a settled signal and guard analytics captures with a fire-once ref. Account for StrictMode double effects.
- A CTA must honor the same permission check as the action it leads to.
- Values from remote config (PostHog payloads) are untrusted. Accept hrefs that start with a single `/` or `https://` only. Use `push`, not `replace`, for cross-page links.
- Key per-user state by `userId`, not per browser. Reset latches when the identity changes.
- `slice(0, n)` splits surrogate pairs. Truncate with `Array.from(str).slice(0, n)` or CSS `truncate`.
- Optional chaining does not protect the result: `errors?.map(...).join(";")` throws when `errors` is undefined.
- Hardening changes warn and continue when failing would not widen exposure (read-only fs, symlinked config). Resolve symlinks before type-checking a path.
- RunPod dataloaders: copy the sibling pattern (scalar select, then a second `findMany`) so one orphaned row does not fail the batch. SDL descriptions must not overclaim.
- After removing a feature, grep for dead GraphQL operations, unused exports, and comments that still mention the removed flag or path. Rerun codegen.
- One source per constant. Hoist shared URLs and form field names to `@constants`.
- Spell-check user-facing copy.

#### Tests

- Test the logic, not prop forwarding. An assertion that cannot fail (sync check on an async mock, negative check on code that never runs) is worse than none.
- Clear mocks between tests. Never read `mock.calls[0]` left over from a previous test.
- Do not depend on ambient env. Stub `process.env` explicitly, and read env inside the function so tests flip it without `resetModules`.
- Query the role the component renders (`link` vs `button`).
- jsdom lacks `structuredClone` and `matchMedia`. Mock them or add a `@jest-environment node` docblock.

#### Sonar and lint before pushing

- Six PRs needed a follow-up "sonar fix" commit. Extract helpers up front to stay under the cognitive-complexity gate, prefer `structuredClone` over JSON round-trips, and remove unused props and state before pushing.

#### PR hygiene

- Fill the template before un-drafting: no "pics incoming", Before and After filled, checklist ticked.
- Add a "Things to know" section naming known tradeoffs and edge cases (exposure timing, per-browser semantics, forms left out of scope).
- Update the docs that describe the changed behavior in the same PR (architecture docs, the runpodctl skill in `runpod-plugins-official`).
- RunPod squash-merges with commit messages in the body. Intermediate commits with `feat:` or `fix:` subjects leak into release notes. Use `wip:` or squash locally first.
