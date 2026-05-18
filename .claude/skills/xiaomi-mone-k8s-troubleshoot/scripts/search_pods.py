#!/usr/bin/env python3
"""
search_pods.py — Kubernetes Pod 검색 스크립트

라벨 셀렉터 및 네임스페이스 기반으로 Pod를 검색하여 JSON을 반환합니다.

출처: XiaoMi SmartSRE SkillHub (xiaomi-mone-k8s-troubleshoot) CLI 호환 구현
SkillHub URL: https://www.skillhub.club/skills/xiaomi-mone-k8s-troubleshoot
업스트림 경로: jcommon/mcp/mcp-smartsre/.claude/skills/k8s-troubleshoot/

보안 원칙:
  - subprocess에서 shell=True 미사용
  - kubectl 인수를 리스트로 전달
  - 런타임 패키지 설치 없음 (표준 라이브러리만 사용)
"""

import argparse
import json
import subprocess
import sys
from typing import List, Optional


def build_kubectl_args(
    namespace: str,
    label_selector: Optional[str],
) -> List[str]:
    """kubectl get pods 명령을 위한 인수 리스트를 구성합니다."""
    args: List[str] = [
        "kubectl", "get", "pods",
        "-o", "wide",
        "--no-headers",
    ]

    if namespace.lower() == "all":
        args.append("-A")
    else:
        args.extend(["-n", namespace])

    if label_selector:
        args.extend(["-l", label_selector])

    return args


def parse_pod_line(line: str, all_namespaces: bool) -> Optional[dict]:
    """
    `kubectl get pods -o wide --no-headers` 출력 한 줄을 파싱합니다.

    일반 네임스페이스 컬럼 순서:
      NAME  READY  STATUS  RESTARTS  AGE  IP  NODE  NOMINATED NODE  READINESS GATES

    -A (all-namespaces) 컬럼 순서:
      NAMESPACE  NAME  READY  STATUS  RESTARTS  AGE  IP  NODE  ...
    """
    parts = line.split()
    if not parts:
        return None

    try:
        if all_namespaces:
            if len(parts) < 6:
                return None
            return {
                "namespace": parts[0],
                "name": parts[1],
                "ready": parts[2],
                "phase": parts[3],
                "restarts": _parse_restarts(parts[4]),
                "age": parts[5],
                "node": parts[7] if len(parts) > 7 else "",
            }
        else:
            if len(parts) < 5:
                return None
            return {
                "name": parts[0],
                "ready": parts[1],
                "phase": parts[2],
                "restarts": _parse_restarts(parts[3]),
                "age": parts[4],
                "node": parts[6] if len(parts) > 6 else "",
            }
    except (IndexError, ValueError):
        return None


def _parse_restarts(value: str) -> int:
    """재시작 횟수를 파싱합니다. '3 (2h ago)' 형태 처리."""
    try:
        return int(value.split()[0])
    except (ValueError, IndexError):
        return 0


def search_pods(namespace: str, label_selector: Optional[str]) -> dict:
    """Pod를 검색하고 결과를 딕셔너리로 반환합니다."""
    all_namespaces = namespace.lower() == "all"
    args = build_kubectl_args(namespace, label_selector)

    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=30,
            # shell=False (기본값) — 절대 shell=True 사용 금지
        )
    except FileNotFoundError:
        return {
            "ok": False,
            "error": "kubectl을 찾을 수 없습니다. PATH에 kubectl이 있는지 확인하십시오.",
            "namespace": namespace,
            "label_selector": label_selector,
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "error": "kubectl 명령이 30초 초과로 타임아웃되었습니다.",
            "namespace": namespace,
            "label_selector": label_selector,
        }

    if result.returncode != 0:
        return {
            "ok": False,
            "error": result.stderr.strip() or "kubectl 명령이 0이 아닌 코드로 종료되었습니다.",
            "returncode": result.returncode,
            "namespace": namespace,
            "label_selector": label_selector,
        }

    pods: List[dict] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        pod = parse_pod_line(line, all_namespaces)
        if pod:
            if not all_namespaces:
                pod["namespace"] = namespace
            pods.append(pod)

    return {
        "success": True,
        "ok": True,
        "namespace": namespace,
        "label_selector": label_selector or "",
        "podCount": len(pods),
        "pods": pods,
        "count": len(pods),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Kubernetes Pod를 라벨 셀렉터와 네임스페이스로 검색합니다.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  %(prog)s -l app=myapp -n production
  %(prog)s -l "app=myapp,tier=backend" -n all
  %(prog)s --label-selector version=v2 --namespace kube-system
        """,
    )
    parser.add_argument(
        "-l", "--label-selector",
        metavar="SELECTOR",
        help="라벨 셀렉터 (예: app=myapp 또는 app=myapp,env=prod)",
    )
    parser.add_argument(
        "-n", "--namespace",
        metavar="NAMESPACE",
        default="default",
        help="네임스페이스. 'all' 지정 시 전체 네임스페이스 검색 (기본값: default)",
    )

    args = parser.parse_args()
    result = search_pods(
        namespace=args.namespace,
        label_selector=args.label_selector,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
