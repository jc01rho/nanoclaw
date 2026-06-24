#!/usr/bin/env python3
"""
cleanup_pods.py — 2일 이상 Error/CrashLoopBackOff 상태인 Pod 삭제 스크립트

kubectl get pods -o json 으로 정확한 시작 시각을 구한 뒤,
2일(48시간) 이상 Error/CrashLoopBackOff/ImagePullBackOff/Evicted/Failed
상태인 Pod를 식별하여 삭제합니다.

보안 원칙 (search_pods.py 와 동일):
  - subprocess 에서 shell=True 미사용
  - kubectl 인수를 리스트로 전달
  - 런타임 패키지 설치 없음 (표준 라이브러리만 사용)
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional


# 삭제 대상 Pod 상태 목록
ERROR_PHASES = frozenset([
    "Error",
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "Evicted",
    "Failed",
])

# 기본 임계값: 2일 (48시간)
DEFAULT_MAX_AGE_HOURS = 48


def get_pods_json(namespace: str, label_selector: Optional[str]) -> Dict[str, Any]:
    """kubectl get pods -o json 실행 결과를 반환합니다."""
    args: List[str] = ["kubectl", "get", "pods", "-o", "json"]

    if namespace.lower() == "all":
        args.append("-A")
    else:
        args.extend(["-n", namespace])

    if label_selector:
        args.extend(["-l", label_selector])

    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=30,
            # shell=False (기본값)
        )
    except FileNotFoundError:
        return {
            "ok": False,
            "error": "kubectl을 찾을 수 없습니다. PATH에 kubectl이 있는지 확인하십시오.",
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "error": "kubectl 명령이 30초 초과로 타임아웃되었습니다.",
        }

    if result.returncode != 0:
        return {
            "ok": False,
            "error": result.stderr.strip() or "kubectl 명령이 0이 아닌 코드로 종료되었습니다.",
            "returncode": result.returncode,
        }

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        return {
            "ok": False,
            "error": f"kubectl JSON 출력 파싱 실패: {e}",
        }


def parse_start_time(pod: Dict[str, Any]) -> Optional[datetime]:
    """Pod의 status.startTime 을 UTC datetime 으로 파싱합니다."""
    start_time_str = (
        pod.get("status", {}).get("startTime")
    )
    if not start_time_str:
        return None

    # RFC 3339 형식: "2024-06-20T09:00:00Z" 또는 "2024-06-20T09:00:00+09:00"
    try:
        # Python 3.7+ datetime.fromisoformat 은 'Z' 를 직접 처리하지 못함
        normalized = start_time_str.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)
    except (ValueError, TypeError):
        return None


def find_stale_error_pods(
    pods_json: Dict[str, Any],
    max_age_hours: int,
) -> List[Dict[str, Any]]:
    """2일 이상 Error 상태인 Pod 목록을 반환합니다."""
    items = pods_json.get("items", [])
    if not isinstance(items, list):
        return []

    now = datetime.now(timezone.utc)
    threshold = now - timedelta(hours=max_age_hours)
    stale: List[Dict[str, Any]] = []

    for pod in items:
        if not isinstance(pod, dict):
            continue

        phase = pod.get("status", {}).get("phase", "")
        # CrashLoopBackOff 등은 phase 가 아닌 reason 으로 표시될 수 있음
        reason = pod.get("status", {}).get("reason", "")
        container_statuses = (
            pod.get("status", {}).get("containerStatuses", []) or []
        )

        # 상태 확인: phase 또는 reason 또는 container waiting reason
        is_error = phase in ERROR_PHASES or reason in ERROR_PHASES
        if not is_error:
            for cs in container_statuses:
                wait_reason = (
                    cs.get("state", {}).get("waiting", {}).get("reason", "")
                )
                if wait_reason in ERROR_PHASES:
                    is_error = True
                    break

        if not is_error:
            continue

        start_time = parse_start_time(pod)
        if start_time is None:
            # startTime 이 없으면 creationTimestamp 로 fallback
            creation_ts = pod.get("metadata", {}).get("creationTimestamp")
            if creation_ts:
                try:
                    normalized = creation_ts.replace("Z", "+00:00")
                    start_time = datetime.fromisoformat(normalized)
                except (ValueError, TypeError):
                    pass

        if start_time is None:
            continue

        if start_time <= threshold:
            stale.append({
                "namespace": pod.get("metadata", {}).get("namespace", ""),
                "name": pod.get("metadata", {}).get("name", ""),
                "phase": phase,
                "reason": reason,
                "startTime": start_time.isoformat(),
                "ageHours": round((now - start_time).total_seconds() / 3600, 1),
            })

    return stale


def delete_pod(namespace: str, name: str) -> Dict[str, Any]:
    """단일 Pod를 삭제합니다."""
    args: List[str] = [
        "kubectl", "delete", "pod", name,
        "-n", namespace,
        "--grace-period=30",
    ]

    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "kubectl delete 타임아웃"}
    except FileNotFoundError:
        return {"ok": False, "error": "kubectl을 찾을 수 없습니다"}

    if result.returncode != 0:
        return {
            "ok": False,
            "error": result.stderr.strip() or "삭제 실패",
            "returncode": result.returncode,
        }

    return {"ok": True, "output": result.stdout.strip()}


def cleanup_pods(
    namespace: str,
    label_selector: Optional[str],
    max_age_hours: int,
    dry_run: bool,
) -> Dict[str, Any]:
    """메인 cleanup 로직."""
    pods_json = get_pods_json(namespace, label_selector)
    if not pods_json.get("ok", True):
        return pods_json

    stale = find_stale_error_pods(pods_json, max_age_hours)

    if not stale:
        return {
            "ok": True,
            "namespace": namespace,
            "label_selector": label_selector or "",
            "maxAgeHours": max_age_hours,
            "staleCount": 0,
            "deleted": [],
            "failed": [],
            "message": f"{max_age_hours}시간 이상 Error 상태인 Pod가 없습니다.",
        }

    deleted: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []

    for pod in stale:
        ns = pod["namespace"]
        name = pod["name"]

        if dry_run:
            deleted.append({**pod, "dryRun": True})
            continue

        result = delete_pod(ns, name)
        if result.get("ok"):
            deleted.append({**pod, "deleted": True})
        else:
            failed.append({**pod, "error": result.get("error", "unknown")})

    return {
        "ok": True,
        "namespace": namespace,
        "label_selector": label_selector or "",
        "maxAgeHours": max_age_hours,
        "dryRun": dry_run,
        "staleCount": len(stale),
        "deletedCount": len(deleted),
        "failedCount": len(failed),
        "deleted": deleted,
        "failed": failed,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="2일 이상 Error/CrashLoopBackOff 상태인 Pod를 삭제합니다.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  %(prog)s -n production
  %(prog)s -n all --dry-run
  %(prog)s -l app=myapp -n staging --max-age-hours 72
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
        default="all",
        help="네임스페이스. 'all' 지정 시 전체 네임스페이스 검색 (기본값: all)",
    )
    parser.add_argument(
        "--max-age-hours",
        type=int,
        default=DEFAULT_MAX_AGE_HOURS,
        help=f"이 시간 이상 Error 상태인 Pod만 삭제 (기본값: {DEFAULT_MAX_AGE_HOURS})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="삭제하지 않고 대상 Pod만 출력합니다.",
    )

    args = parser.parse_args()
    result = cleanup_pods(
        namespace=args.namespace,
        label_selector=args.label_selector,
        max_age_hours=args.max_age_hours,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
