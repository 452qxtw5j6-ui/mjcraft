# Craft Agent 신버전 업데이트 절차 가이드

> 비개발자용 — 터미널에서 복사-붙여넣기로 실행 가능

## 전체 흐름 요약

```
1. 현재 변경사항 패치로 백업
2. 새 버전 코드 받기 (git pull)
3. 패치 재적용
4. 의존성 설치 & 빌드
5. 실행 확인
```

---

## Step 0: 준비

터미널을 열고 repo 폴더로 이동:
```bash
cd ~/path/to/craft-agents-oss
```

> 현재 경로 예시:
> `cd ~/.craft-agent/workspaces/my-workspace/sessions/260228-coral-meadow/craft-agents-oss`

---

## Step 1: 현재 변경사항 패치 백업

```bash
~/craft-patch-backup.sh -m "v0.5.1 업데이트 전 백업"
```

결과 확인:
```bash
~/craft-patch-backup.sh --list
```

> 이미 `.01`, `.02` 패치가 있으므로 `.03`이 생성됩니다.

---

## Step 2: 변경사항 임시 보관 (stash)

```bash
git stash push -m "my-customizations-before-update"
```

> 이 명령은 내 모든 변경사항을 임시 보관소에 넣고, 코드를 원래 상태로 되돌립니다.
> `git stash list`로 보관된 것을 확인할 수 있습니다.

---

## Step 3: 새 버전 받기

```bash
git pull origin main
```

> 새 버전이 나왔다면 새 커밋들이 다운로드됩니다.
> "Already up to date."가 나오면 아직 새 버전이 없는 겁니다.

---

## Step 4: 패치 재적용

### 방법 A: stash에서 복원 (추천, 간단)

```bash
git stash pop
```

> **충돌이 없으면**: 끝! Step 5로 진행
> **충돌이 있으면**: 아래 "충돌 해결" 섹션 참고

### 방법 B: 패치 파일에서 적용 (stash 실패 시 대안)

```bash
# 가장 최신 패치 파일 적용
git apply --3way ~/Library/Mobile\ Documents/com~apple~CloudDocs/craft_patch/craft-agent-v0.5.1.03.patch
```

> `--3way`는 충돌이 있어도 3-way merge로 최대한 자동 처리해줍니다.

---

## Step 5: 의존성 설치 & 빌드

```bash
bun install
bun run build
```

> 새 버전에서 패키지가 추가/변경되었을 수 있으므로 `bun install`은 반드시 실행

---

## Step 6: 실행 확인

```bash
bun run dev
```

> 앱이 정상 실행되는지, MJCraft 이름/아이콘이 유지되는지 확인

---

## Step 7: 업데이트 후 새 패치 생성

모든 게 잘 되면, 새 버전 기준으로 패치를 다시 저장:

```bash
~/craft-patch-backup.sh -m "v{새버전} 커스텀 적용 완료"
```

---

## 충돌 해결 (Conflict)

충돌이 발생하면 터미널에 이런 메시지가 나옵니다:
```
CONFLICT (content): Merge conflict in apps/electron/package.json
```

### 비개발자를 위한 가장 쉬운 방법

**Craft Agent에게 도움 요청:**
```
충돌이 발생했어요. 해결해주세요.
```
→ Craft Agent가 충돌 파일을 읽고 자동으로 해결해줄 수 있습니다.

### 수동 해결이 필요한 경우

1. 충돌 파일 열기 (VS Code 등)
2. `<<<<<<<`, `=======`, `>>>>>>>` 마커를 찾기
3. 원하는 내용만 남기고 마커 삭제
4. 저장 후:
```bash
git add .
git stash drop   # stash pop으로 복원한 경우
```

---

## 긴급 롤백 (원래대로 되돌리기)

업데이트가 잘못되었을 때:

```bash
# 모든 변경 취소하고 업데이트 전 상태로
git checkout .
git stash pop    # stash에 보관한 내 변경사항 복원
```

또는 특정 버전으로 완전히 되돌리기:
```bash
git reset --hard v0.5.1    # v0.5.1로 완전 복귀
git apply --3way ~/Library/Mobile\ Documents/com~apple~CloudDocs/craft_patch/craft-agent-v0.5.1.02.patch
```

---

## 빠른 참조 카드

| 상황 | 명령어 |
|------|--------|
| 패치 백업 | `~/craft-patch-backup.sh` |
| 패치 목록 보기 | `~/craft-patch-backup.sh -l` |
| 내 변경 임시 보관 | `git stash push -m "설명"` |
| 새 코드 받기 | `git pull origin main` |
| 보관한 변경 복원 | `git stash pop` |
| 패치로 복원 | `git apply --3way 패치파일경로` |
| 의존성 설치 | `bun install` |
| 빌드 | `bun run build` |
| 실행 | `bun run dev` |
| 현재 버전 확인 | `node -p "require('./package.json').version"` |

---

## 주의사항

1. **패치 파일명의 버전**: 패치는 만들었을 때의 버전 기준입니다.
   - `craft-agent-v0.5.1.02.patch`는 v0.5.1 코드에서 만든 패치
   - 새 버전(예: v0.5.2)에 적용할 때 충돌 가능성 있음

2. **`--3way` 옵션**: 패치 적용 시 항상 `--3way`를 사용하세요. 충돌을 자동으로 최대한 해결해줍니다.

3. **appId 변경 주의**: MJCraft 리브랜딩에서 `appId`를 변경한 경우, 업데이트 후 새 버전의 appId와 충돌할 수 있습니다. 이 파일은 수동 확인이 필요합니다.

4. **iCloud 동기화**: 패치 파일은 iCloud에 저장되므로 다른 Mac에서도 접근 가능합니다.
