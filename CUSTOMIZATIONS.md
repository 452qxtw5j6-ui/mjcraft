# MJCraft Customizations

## Must Keep
- Slack and Notion linked session flow
- Session metadata links:
  - `sessionOrigin`
  - `notionRef`
  - `slackRef`
- Current top-level UI affordances required for daily workflow

## Nice To Keep
- Non-critical UI refinements around badges, labels, and top bar actions
- Build and packaging adjustments that improve local operation

## Can Drop
- Legacy patch-based recovery workflow in `patches/craft_patch`
- Temporary or experimental workflow artifacts that are no longer used

## Upgrade Hotspots
- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/ipc.ts`
- `apps/electron/src/main/sessions.ts`
- `apps/electron/src/renderer/components/app-shell/TopBar.tsx`
- `apps/electron/src/shared/types.ts`
- `packages/shared/src/sessions/types.ts`
