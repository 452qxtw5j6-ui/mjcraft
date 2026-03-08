# MJCraft Customizations

## Must Keep
- Slack and Notion linked session flow
- Session metadata links:
  - `sessionOrigin`
  - `notionRef`
  - `slackRef`
- 커스텀 핵심 기능에 포함된 UI는 유지
  - 예: 기능 실행 버튼, 기능 상태 표시, 기능 전용 진입 UI, 기능 결과를 이해하는 데 필요한 표시

## Nice To Keep
- 없음. 사소한 UI 변경은 업그레이드 시 기본적으로 버림
- Build and packaging adjustments that improve local operation

## Can Drop
- Legacy patch-based recovery workflow in `patches/craft_patch`
- Temporary or experimental workflow artifacts that are no longer used
- 커스텀 핵심 기능과 무관한 뱃지/레이블/상단바 스타일 변경
- iCloud를 주 소스 저장소로 전제한 운영 방식

## Path Migration Notes
- 기존 iCloud 기반 소스 경로가 문서, 설정, 자동화, 스크립트에 남아 있는지 점검 필요
- 업그레이드 이후 활성 소스 경로는 호스트 Mac의 로컬 작업 디렉터리를 기준으로 재정의
- 두 번째 Mac은 GitHub clone/pull 기준으로 동일 소스를 맞춤
- iCloud는 문서/정적 자산 보조 저장소로만 유지

## Upgrade Hotspots
- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/ipc.ts`
- `apps/electron/src/main/sessions.ts`
- `apps/electron/src/renderer/components/app-shell/TopBar.tsx`
- `apps/electron/src/shared/types.ts`
- `packages/shared/src/sessions/types.ts`
