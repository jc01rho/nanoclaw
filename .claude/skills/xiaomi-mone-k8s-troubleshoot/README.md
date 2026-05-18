# xiaomi-mone-k8s-troubleshoot

XiaoMi SmartSRE 팀의 SkillHub 스킬 설계를 기반으로 한 Kubernetes 트러블슈팅 스킬의 로컬 호환 구현입니다.

## 출처 및 라이선스

| 항목 | 내용 |
|------|------|
| SkillHub URL | https://www.skillhub.club/skills/xiaomi-mone-k8s-troubleshoot |
| 업스트림 경로 | `jcommon/mcp/mcp-smartsre/.claude/skills/k8s-troubleshoot/` |
| 업스트림 저장소 | XiaoMi/mone (현재 비공개 — 원본 Python 스크립트 본문 접근 불가) |
| 라이선스 | Apache-2.0 |

> **중요**: 이 구현은 SkillHub 플레이북 캐시에서 문서화된 CLI 형태(인터페이스)와 JSON 계약만을 재현합니다.  
> 업스트림 비공개 저장소의 소스 코드를 복제하거나 역공학하지 않았습니다.

## 포함 파일

```
xiaomi-mone-k8s-troubleshoot/
├── SKILL.md                      # 주 스킬 설명 (AgentSkills 형식)
├── README.md                     # 이 파일
├── references/
│   └── SECURITY.md              # 보안 감사 결과 및 제약사항
└── scripts/
    ├── search_pods.py           # Pod 검색 (라벨/네임스페이스)
    └── exec_pod.py              # Pod 내 명령 실행
```

## 빠른 시작

### 스크립트 실행 권한 설정

```bash
chmod +x .claude/skills/xiaomi-mone-k8s-troubleshoot/scripts/*.py
```

### Pod 검색

```bash
# 특정 네임스페이스에서 라벨로 검색
python3 scripts/search_pods.py -l app=myapp -n production

# 전체 네임스페이스 검색
python3 scripts/search_pods.py -l "app=myapp" -n all
```

### Pod 내 명령 실행

```bash
# 기본 명령 실행
python3 scripts/exec_pod.py -p myapp-pod-xxxx -n production -cmd "ls /app"

# 특정 컨테이너 지정
python3 scripts/exec_pod.py -p myapp-pod-xxxx -n production -c sidecar -cmd "cat /etc/hosts"
```

## 요구사항

| 항목 | 버전/설명 |
|------|----------|
| kubectl | v1.20+ (Docker 컨테이너에 고정 버전으로 설치됨) |
| Python 3 | 3.8+ stdlib 전용 (`INSTALL_K8S_TOOLS=true` 빌드 인수로 활성화) |
| kubeconfig | NanoClaw 마운트 허용목록을 통해 주입 필요 |
| RBAC | `pods/list`, `pods/get` (exec 포함 시 `pods/exec` 추가 필요) |

## 보안

이 스킬은 다음 보안 원칙을 따릅니다:

- **셸 인젝션 방지**: `subprocess`에서 `shell=True` 미사용. kubectl 인수를 배열로 전달.
- **메타문자 거부**: `|`, `&&`, `;`, `` ` ``, `$()`, 리다이렉션 기호를 기본 거부.
- **자격증명 미포함**: kubeconfig, 클러스터 주소, 토큰을 이 디렉터리에 커밋 금지.
- **최소 권한 RBAC**: 읽기 전용 작업과 exec 작업의 권한 분리.
- **런타임 패키지 설치 금지**: `pip install` 또는 `apt-get`을 스크립트 실행 중 호출하지 않음.

자세한 내용은 [`references/SECURITY.md`](references/SECURITY.md)를 참조하십시오.

## Docker 활성화

Python 3를 컨테이너에서 사용하려면 `.env`에 다음을 추가하십시오:

```bash
INSTALL_K8S_TOOLS=true
```

그 후 컨테이너를 재빌드합니다:

```bash
./container/build.sh
```

## 관련 스킬

- `kubectl` — 일반 kubectl 명령 실행
- `kubernetes-devops` — Kubernetes 매니페스트 생성
- `manage-mounts` — 컨테이너 마운트 허용목록 관리

## 버전 이력

| 버전 | 날짜 | 변경사항 |
|------|------|----------|
| 1.0.1 | 2026-05-06 | 스크립트 파일명 교체 및 SkillHub JSON 호환 키 추가 (`success`, `podCount`, `output`) |
| 1.0.0 | 2026-05-06 | 초기 로컬 구현 (CLI 형태 호환, 보안 강화) |
| 1.0.1 | 2026-05-06 | 스크립트 파일명 교체 (search_pods.py, exec_pod.py) |
