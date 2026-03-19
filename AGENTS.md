# AGENTS.md (Craft Branch Workflow)

## 목적
- 개인 커스텀 개발을 단일 폴더에서 단순하게 운영한다.
- worktree 없이 브랜치만 사용한다.

## 기본 경로
- 개발 폴더: `/Users/mjay1108/Developer/craft-agent-dev`
- 실행/검증 기본 브랜치: `main`

## 작업 규칙
1. 새 기능 시작: `main` 최신화 후 `feature/<name>` 브랜치 생성
2. 기능 개발/테스트: 해당 브랜치에서만 진행
3. 완료 후: `main`에 머지
4. 기능 브랜치: 머지 후 삭제

## 운영 규칙
- DMG 재설치 대신 이 폴더에서 코드 기반으로 개발/검증
- 정적 공유 자산 편집 경로:
  `/Users/mjay1108/Library/Mobile Documents/com~apple~CloudDocs/1_GrowthOps/input`
