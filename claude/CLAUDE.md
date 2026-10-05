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
