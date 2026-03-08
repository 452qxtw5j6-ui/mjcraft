# MJCraft Customizations

## Must Keep
- Slack and Notion linked session flow
- Session metadata links:
  - `sessionOrigin`
  - `notionRef`
  - `slackRef`
- 핵심 기능을 직접 작동시키는 최소 UI 표면만 유지
  - 예: 기능 실행 버튼, 연결 상태를 확인하는 최소 표시

## Nice To Keep
- 없음. 사소한 UI 변경은 업그레이드 시 기본적으로 버림
- Build and packaging adjustments that improve local operation

## Can Drop
- Legacy patch-based recovery workflow in `patches/craft_patch`
- Temporary or experimental workflow artifacts that are no longer used
- 핵심 기능과 직접 연결되지 않은 뱃지/레이블/상단바 스타일 변경

## Upgrade Hotspots
- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/ipc.ts`
- `apps/electron/src/main/sessions.ts`
- `apps/electron/src/renderer/components/app-shell/TopBar.tsx`
- `apps/electron/src/shared/types.ts`
- `packages/shared/src/sessions/types.ts`
