# 보안 감사 및 제약사항

`xiaomi-mone-k8s-troubleshoot` 스킬의 보안 감사 결과 및 적용된 제약사항을 문서화합니다.

---

## 감사 범위

| 항목 | 상태 |
|------|------|
| SkillHub 플레이북 메타데이터 | 확인됨 |
| 업스트림 Python 스크립트 본문 | **접근 불가** (XiaoMi/mone 비공개 저장소) |
| CLI 인터페이스 형태 | SkillHub 캐시에서 복원됨 |
| JSON 출력 계약 | 플레이북 문서에서 복원됨 |

업스트림 스크립트 본문을 직접 검사할 수 없었으므로, 이 로컬 구현은 문서화된 인터페이스를 재현하되 독립적인 보안 제약을 적용합니다.

---

## 식별된 위험 및 완화 방법

### 1. 셸 인젝션 (원래 위험: exec 경로)

**위험**: `kubectl exec -- /bin/sh -c "<user_command>"` 패턴을 사용할 경우, 로컬 `shell=True`를 통해 또는 kubectl에 전달되는 명령 문자열을 통해 셸 인젝션이 가능합니다.

**완화**:
- 로컬 `subprocess`에서 **`shell=True` 절대 미사용**
- kubectl 호출 인수를 항상 **Python 리스트(배열)**로 전달
- `shlex.split()`으로 사용자 명령을 파싱하여 인수 배열 생성
- 다음 메타문자를 **기본 거부** (명시적 `--allow-shell` 없는 경우):

  ```
  |  파이프
  && 조건부 실행
  ;  순차 실행
  `  백틱 치환
  $( 명령 치환
  )  명령 치환 닫기
  >  출력 리다이렉션
  <  입력 리다이렉션
  >> 추가 리다이렉션
  << 히어닥
  ```

- `--allow-shell` 플래그 제공 시: `kubectl exec -- /bin/sh -lc <command>` 형태 사용
  - 셸 해석은 **Pod 내부**에서만 발생
  - 로컬 호스트에서 `shell=True` 미사용

### 2. 자격증명 노출

**위험**: kubeconfig, API 토큰, 클러스터 엔드포인트를 스킬 파일에 하드코딩하면 버전 관리 시스템에 노출됩니다.

**완화**:
- 이 스킬 디렉터리에 자격증명 파일 **절대 커밋 금지**
- kubeconfig는 **NanoClaw 마운트 허용목록**을 통해서만 주입
- `KUBECONFIG` 환경변수로 경로 참조 (파일 내용 직접 포함 금지)

```bash
# 올바른 방법: manage-mounts 스킬로 허용목록에 추가
# 잘못된 방법: kubeconfig 내용을 파일에 복사하거나 환경변수에 인라인 포함
```

### 3. RBAC 권한 과다 부여

**위험**: Pod exec 권한(`pods/exec`)은 컨테이너 내 임의 명령 실행을 허용합니다.

**완화**: 최소 권한 원칙에 따른 역할 분리:

**읽기 전용 ServiceAccount** (search 전용):
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: k8s-troubleshoot-reader
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list", "get"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
```

**exec 포함 ServiceAccount** (별도 승인 필요):
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: k8s-troubleshoot-exec
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list", "get"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
```

### 4. 런타임 패키지 설치

**위험**: 스크립트 실행 중 `pip install`, `apt-get`, `curl | bash` 등을 호출하면 악성 패키지가 설치될 수 있습니다.

**완화**:
- 모든 스크립트는 **Python 3 표준 라이브러리만** 사용
- 런타임 패키지 설치 **절대 금지**
- Python 설치 자체는 Docker 빌드 시점에 `INSTALL_K8S_TOOLS=true` 인수로 처리

### 5. 네임스페이스 `all` 처리

**위험**: `--namespace all`은 `kubectl get pods -A`로 변환되어 클러스터 전체 Pod 목록을 반환합니다. 민감한 시스템 네임스페이스 정보가 포함될 수 있습니다.

**완화**:
- 이 스킬은 읽기 전용 목록 작업만 수행합니다
- exec는 항상 명시적 네임스페이스가 필요합니다 (`all` 미지원)
- 운영 환경에서는 RBAC을 통해 접근 가능한 네임스페이스를 제한하십시오

---

## 컨테이너 마운트 구성 예시

```bash
# NanoClaw manage-mounts 스킬로 kubeconfig 마운트 추가
# ~/.kube/config를 컨테이너의 /workspace/.kube/config로 마운트

# .env에 설정
KUBECONFIG=/workspace/.kube/config
```

---

## 보안 체크리스트

배포 전 확인 사항:

- [ ] kubeconfig 또는 클러스터 자격증명이 이 디렉터리에 포함되지 않음
- [ ] `git log -- scripts/` 에서 민감 데이터 없음 확인
- [ ] RBAC 역할이 최소 권한 원칙에 따라 구성됨
- [ ] `INSTALL_K8S_TOOLS=true`로 Python이 빌드 시점에 설치됨
- [ ] kubeconfig가 마운트 허용목록을 통해 주입됨
- [ ] exec 사용 시 `--allow-shell` 플래그의 위험성을 이해하고 있음

---

## 변경 이력

| 날짜 | 변경자 | 내용 |
|------|--------|------|
| 2026-05-06 | NanoClaw (로컬 구현) | 초기 보안 감사 문서 작성 |
