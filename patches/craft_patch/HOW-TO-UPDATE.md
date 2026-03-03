# 새 버전 업데이트 방법

> Craft Agent 새 버전이 GitHub에 배포되었을 때,
> 내 커스텀(MJCraft 리브랜딩 등)을 새 버전에 적용하는 방법

---

## 0단계: 데이터 백업 (업데이트 전 필수!)

앱의 모든 설정·세션·스킬·소스를 iCloud에 안전하게 백업합니다.

```bash
# 백업 폴더 생성 (날짜별)
BACKUP_DIR=~/Library/Mobile\ Documents/com~apple~CloudDocs/craft_patch/backup-$(date +%Y%m%d)
mkdir -p "$BACKUP_DIR"

# 전체 설정 백업 (config, 인증, 환경설정)
cp ~/.craft-agent/config.json "$BACKUP_DIR/"
cp ~/.craft-agent/preferences.json "$BACKUP_DIR/"
cp ~/.craft-agent/credentials.enc "$BACKUP_DIR/" 2>/dev/null

# 워크스페이스 백업 (세션, 스킬, 소스, 라벨, 상태)
cp -R ~/.craft-agent/workspaces/ "$BACKUP_DIR/workspaces/"

echo "백업 완료: $BACKUP_DIR"
```

### 백업되는 항목

| 항목 | 경로 | 설명 |
|------|------|------|
| 전체 설정 | `config.json` | 연결, 모델, 워크스페이스 설정 |
| 환경설정 | `preferences.json` | 이름, 시간대, 언어 등 |
| 인증 정보 | `credentials.enc` | API 키, OAuth 토큰 (암호화됨) |
| 세션들 | `workspaces/*/sessions/` | 대화 기록, 계획, 첨부파일 |
| 스킬 | `workspaces/*/skills/` | 커스텀 스킬 (SKILL.md) |
| 소스 | `workspaces/*/sources/` | MCP 서버, API 연결 설정 |
| 라벨 | `workspaces/*/labels/` | 세션 라벨 |
| 상태 | `workspaces/*/statuses/` | 워크플로 상태 정의 |

---

## 1단계: repo로 이동
```bash
cd ~/.craft-agent/workspaces/my-workspace/sessions/260228-coral-meadow/craft-agents-oss
```

## 2단계: 코드 패치 백업 & 새 버전 받기
```bash
~/craft-patch-backup.sh -m "업데이트 전 백업"
git checkout .
git pull origin main
```

## 3단계: 패치 입히기
```bash
git apply --3way ~/Library/Mobile\ Documents/com~apple~CloudDocs/craft_patch/craft-agent-v0.5.1.02.patch
```

> 패치 파일명은 `~/craft-patch-backup.sh -l` 로 확인하고 가장 최신 번호를 사용

## 4단계: 빌드 & 실행
```bash
bun install && bun run build && bun run dev
```

## 5단계: 업데이트 후 확인

- [ ] 앱 이름이 MJCraft로 표시되는지
- [ ] 기존 세션들이 보이는지
- [ ] 소스 연결이 정상인지
- [ ] 스킬이 그대로 있는지

---

## 문제 생겼을 때 복원하기

### 설정/데이터 복원
```bash
# 가장 최근 백업 확인
ls ~/Library/Mobile\ Documents/com~apple~CloudDocs/craft_patch/backup-*

# 설정 복원 (예: backup-20260228)
BACKUP_DIR=~/Library/Mobile\ Documents/com~apple~CloudDocs/craft_patch/backup-20260228
cp "$BACKUP_DIR/config.json" ~/.craft-agent/
cp "$BACKUP_DIR/preferences.json" ~/.craft-agent/
cp "$BACKUP_DIR/credentials.enc" ~/.craft-agent/ 2>/dev/null
```

### 세션/스킬/소스 복원
```bash
# 워크스페이스 전체 복원
cp -R "$BACKUP_DIR/workspaces/"* ~/.craft-agent/workspaces/
```

### 코드 충돌 시
Craft Agent 세션에서 **"충돌 해결해줘"** 라고 말하면 됩니다.

---

## 참고: 안전한 항목 vs 주의 항목

| 항목 | 업데이트 영향 | 설명 |
|------|:---:|------|
| 세션/대화 기록 | 안전 | `~/.craft-agent/`에 저장, repo와 무관 |
| 스킬 | 안전 | `~/.craft-agent/`에 저장 |
| 소스/MCP 설정 | 안전 | `~/.craft-agent/`에 저장 |
| 환경설정 | 안전 | `~/.craft-agent/`에 저장 |
| MJCraft 리브랜딩 | 패치 필요 | repo 코드 변경이므로 매번 패치 적용 |
| 인증 토큰 | 대부분 안전 | appId 변경 시 재인증 필요할 수 있음 |
