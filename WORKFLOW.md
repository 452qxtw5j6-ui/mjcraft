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
- During upstream upgrades, keep UI that is part of a core custom feature and drop only unrelated cosmetic refinements by default
- Use Git commits as the source of truth for customizations
- Treat `patches/craft_patch` as legacy history only
- Do not use iCloud as the primary source-code sync mechanism
- Keep the active repository on the host Mac's local disk
- Sync source code between Macs through GitHub, not iCloud
- Reserve iCloud for optional documents or intentionally shared static assets only

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
