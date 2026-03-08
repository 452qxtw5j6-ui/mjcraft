# MJCraft Workflow

## Branch Roles
- `main`: stable, runnable branch only
- `codex/feature/*`: feature development
- `codex/upgrade/*`: upstream upgrade work only
- `codex/archive/*`: historical preservation only

## Required Rules
- Never develop directly on `main`
- Start new work from a clean `main`
- Keep feature logic and the UI needed for that feature together
- Split unrelated UI, build, and infra changes into separate branches or commits
- Use Git commits as the source of truth for customizations
- Treat `patches/craft_patch` as legacy history only

## Merge Readiness
- The branch builds or has known baseline failures that are unrelated to the feature
- The feature's targeted tests pass
- Known gaps are documented as TODOs
- `main` is clean before and after merge

## Upgrade Flow
- Create `codex/upgrade/<version>` from clean `main`
- Fetch upstream tags and review release notes before merging
- Reapply only required customizations
- Review hotspot files first:
  - `apps/electron/src/main/index.ts`
  - `apps/electron/src/main/ipc.ts`
  - `apps/electron/src/main/sessions.ts`
