---
name: xiaomi-mone-k8s-troubleshoot
description: |
  WHAT: Kubernetes 클러스터 트러블슈팅 자동화 스킬. Pod/컨테이너 검색, 명령 실행, 이벤트 분석, 리소스 상태 요약을 안전하게 수행한다.
  WHEN: Kubernetes 클러스터에서 Pod 오류 진단, 라벨 기반 검색, Pod 내 명령 실행(exec), CrashLoopBackOff/OOMKilled 분석이 필요할 때 사용.
  KEYWORDS: kubernetes, k8s, pod, troubleshoot, search, exec, label-selector, namespace, container, smartsre, diagnosis, debug, mone
license: Apache-2.0
metadata:
  provenance: |
    SkillHub URL: https://www.skillhub.club/skills/xiaomi-mone-k8s-troubleshoot
    Upstream path: jcommon/mcp/mcp-smartsre/.claude/skills/k8s-troubleshoot/
    Source: XiaoMi/mone (private repository — raw Python script bodies were NOT publicly retrievable at audit time)
    This implementation reproduces the documented CLI shape and JSON contract from the SkillHub playbook cache.
    It does NOT contain any code copied from the upstream private repository.
  author: XiaoMi SmartSRE Team (upstream); NanoClaw local implementation (vendored)
  version: "1.0.0"
  keywords: "kubernetes,k8s,pod,troubleshoot,search,exec,namespace,label-selector,container,smartsre"
compatibility: |
  Requires kubectl binary (pinned in container). Python 3 stdlib only — no third-party packages.
  Python 3 must be present in the container (enabled via INSTALL_K8S_TOOLS=true Docker opt-in gate).
  kubeconfig must be mounted via the NanoClaw mount allowlist (not embedded in this skill).
---

# xiaomi-mone-k8s-troubleshoot

안전한 Kubernetes 클러스터 트러블슈팅 스킬. XiaoMi SmartSRE 팀의 SkillHub 스킬 설계를 기반으로 한 로컬 호환 구현입니다.

> **출처 주의**: 업스트림 Python 스크립트 본문은 `XiaoMi/mone` 비공개 저장소에 위치하며, 감사 시점에 공개 접근이 불가능했습니다.  
> 이 구현은 SkillHub 플레이북 캐시에서 확인된 CLI 형태(인터페이스)와 JSON 계약만을 재현합니다.

---

## 사전 요구사항

| 항목 | 설명 |
|------|------|
| `kubectl` | 컨테이너에 고정 버전으로 설치됨 (Dockerfile 참조) |
| `python3` | stdlib 전용. `INSTALL_K8S_TOOLS=true` Docker 빌드 인수로 활성화 |
| kubeconfig | NanoClaw 마운트 허용목록을 통해 주입 (`manage-mounts` 스킬 참조) |
| RBAC | 읽기 전용: `pods/list`, `pods/get`. exec용: `pods/exec` (최소 권한 원칙 적용) |

**kubeconfig 또는 클러스터 자격증명을 이 스킬 디렉터리에 절대 커밋하지 마십시오.**

---

## 스크립트 참조

| 스크립트 | 기능 |
|----------|------|
| `scripts/search_pods.py` | Pod 검색 (라벨/네임스페이스) → JSON 반환 |
| `scripts/exec_pod.py` | Pod 내 명령 실행 → JSON 반환 (셸 메타문자 거부) |

---

## 사용 방법

### Pod 검색 (`search_pods.py`)

```bash
python3 scripts/search_pods.py -l app=myapp -n production
python3 scripts/search_pods.py -l "app=myapp,tier=backend" -n all
python3 scripts/search_pods.py --label-selector "version=v2" --namespace kube-system
```

**옵션:**

| 플래그 | 설명 |
|--------|------|
| `-l`, `--label-selector` | 라벨 셀렉터 (예: `app=myapp`, `app=myapp,env=prod`) |
| `-n`, `--namespace` | 네임스페이스. `all` 지정 시 전체 네임스페이스 검색 |

**JSON 출력 형식:**
```json
{
  "success": true,
  "ok": true,
  "namespace": "production",
  "label_selector": "app=myapp",
  "pods": [
    {
      "name": "myapp-7d9f8b-xk2lp",
      "namespace": "production",
      "phase": "Running",
      "ready": "2/2",
      "restarts": 0,
      "node": "node-01",
      "age": "2d"
    }
  ],
  "podCount": 1,
  "count": 1
}
```

---

### Pod 명령 실행 (`exec_pod.py`)

```bash
python3 scripts/exec_pod.py -p myapp-7d9f8b-xk2lp -n production -cmd "ls /app"
python3 scripts/exec_pod.py -p myapp-7d9f8b-xk2lp -n production -c sidecar -cmd "cat /etc/hosts"
```

**옵션:**

| 플래그 | 설명 |
|--------|------|
| `-p`, `--pod` | Pod 이름 (필수) |
| `-n`, `--namespace` | 네임스페이스 (기본값: `default`) |
| `-c`, `--container` | 컨테이너 이름 (생략 시 첫 번째 컨테이너) |
| `-cmd`, `--command` | 실행할 명령 (문자열, `shlex.split`으로 파싱) |
| `--allow-shell` | 셸 메타문자 허용 플래그 (아래 보안 절 참조) |

**JSON 출력 형식:**
```json
{
  "success": true,
  "ok": true,
  "pod": "myapp-7d9f8b-xk2lp",
  "namespace": "production",
  "container": "myapp",
  "command": ["ls", "/app"],
  "output": "bin\nlib\nmain.py\n",
  "stdout": "bin\nlib\nmain.py\n",
  "stderr": "",
  "returncode": 0
}
```

**오류 시:**
```json
{
  "success": false,
  "ok": false,
  "error": "Shell metacharacter rejected: '|'. Use --allow-shell to permit.",
  "pod": "myapp-7d9f8b-xk2lp"
}
```

---

## 보안 제약사항

자세한 내용은 [`references/SECURITY.md`](references/SECURITY.md)를 참조하십시오.

### 셸 인젝션 방지

`exec_pod.py`는 다음 메타문자를 기본적으로 거부합니다:

```
| && ; ` $( ) > < >> <<
```

`--allow-shell` 플래그를 명시적으로 전달할 경우:
- 로컬 `subprocess`에서 `shell=True`를 **사용하지 않습니다**
- 대신 `kubectl exec -- /bin/sh -lc "<command>"` 형태로 실행됩니다
- 셸 해석은 **Pod 내부**에서만 발생합니다 (로컬 호스트에서 발생하지 않음)

### RBAC 최소 권한

읽기 전용 작업 (search):
```yaml
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list", "get"]
```

exec 포함 시 추가:
```yaml
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
```

### kubeconfig 마운트

kubeconfig는 NanoClaw 마운트 허용목록을 통해서만 주입해야 합니다:
```bash
# manage-mounts 스킬로 허용목록에 추가
# 예: ~/.kube/config → /workspace/.kube/config
```

자격증명을 환경변수나 파일로 이 디렉터리에 커밋하지 마십시오.

---

## 일반적인 트러블슈팅 패턴

### CrashLoopBackOff 진단
```bash
# 1. 문제 Pod 찾기
python3 scripts/k8s_search.py -l app=myapp -n production

# 2. kubectl로 상세 확인
kubectl describe pod <POD_NAME> -n production

# 3. 이전 컨테이너 로그
kubectl logs <POD_NAME> -n production --previous

# 4. 환경변수 확인 (exec)
python3 scripts/k8s_exec.py -p <POD_NAME> -n production -cmd "env"
```

### OOMKilled 분석
```bash
# 메모리 사용량 확인
kubectl top pod <POD_NAME> -n production

# 리소스 제한 확인
kubectl get pod <POD_NAME> -n production -o jsonpath='{.spec.containers[*].resources}'
```

### 멀티 네임스페이스 검색
```bash
# 전체 네임스페이스에서 라벨로 검색
python3 scripts/k8s_search.py -l app=myapp -n all
```

---

## 환경변수

| 변수 | 설명 |
|------|------|
| `KUBECONFIG` | kubeconfig 파일 경로 (마운트 허용목록으로 주입) |
| `INSTALL_K8S_TOOLS` | `true`로 설정 시 Docker 빌드에서 Python 3 활성화 |

---

## 관련 문서

- [`references/SECURITY.md`](references/SECURITY.md) — 보안 감사 결과 및 제약사항
- [`scripts/k8s_search.py`](scripts/k8s_search.py) — Pod 검색 스크립트
- [`scripts/k8s_exec.py`](scripts/k8s_exec.py) — Pod exec 스크립트
- [SkillHub: xiaomi-mone-k8s-troubleshoot](https://www.skillhub.club/skills/xiaomi-mone-k8s-troubleshoot)
- 업스트림 경로: `jcommon/mcp/mcp-smartsre/.claude/skills/k8s-troubleshoot/`

---

**버전**: 1.0.1  
**라이선스**: Apache-2.0  
**호환성**: kubectl v1.20+, Python 3.8+, Kubernetes v1.20+
