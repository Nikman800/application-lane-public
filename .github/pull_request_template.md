## What this changes

<!-- A sentence or two: what and why. Link the issue if there is one. -->

## How it was tested

<!-- Commands run, browser tests, sites tried (with synthetic data). -->

## Checklist

- [ ] `npm run check` passes
- [ ] Unit tests pass (`node --import tsx --test tests/*.test.ts`)
- [ ] `npm run build` succeeds
- [ ] Related browser tests pass (`npx playwright test tests/browser/extension.spec.ts -g "<pattern>"`), if the extension or site rules changed
- [ ] Tests added or updated
- [ ] Docs and CHANGELOG updated for user-visible changes
- [ ] No personal data, tokens or API keys in the diff or screenshots
- [ ] The extension still never submits, never clicks Next, and never overwrites the user's edits
