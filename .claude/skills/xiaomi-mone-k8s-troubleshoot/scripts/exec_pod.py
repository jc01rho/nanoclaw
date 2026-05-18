#!/usr/bin/env python3
# XiaoMi SmartSRE SkillHub CLI 호환 구현 — 표준 라이브러리 전용
# SkillHub: https://www.skillhub.club/skills/xiaomi-mone-k8s-troubleshoot
# 업스트림 경로: jcommon/mcp/mcp-smartsre/.claude/skills/k8s-troubleshoot/
# 보안: shell=True 미사용, 셸 메타문자 검사, shlex.split 사용

import argparse
import json
import re
import shlex
import subprocess
import sys
from typing import List, Optional


FORBIDDEN_SHELL_PATTERNS = (
    r"\|",
    r"&&",
    r";",
    r"`",
    r"\$\(",
    r">>",
    r"<<",
    r">",
    r"<",
)


def contains_forbidden_metachrs(command: str) -> bool:
    for pattern in FORBIDDEN_SHELL_PATTERNS:
        if re.search(pattern, command):
            return True
    return False


def build_kubectl_args(
    pod: str,
    namespace: str,
    container: Optional[str],
    command_str: str,
    command_list: List[str],
    allow_shell: bool,
) -> List[str]:
    args: List[str] = ["kubectl", "exec", pod, "-n", namespace]
    if container:
        args.extend(["-c", container])
    if allow_shell:
        # Pod 내부에서 셸 실행 — 로컬 shell=False 유지
        args.append("--")
        args.append("/bin/sh")
        args.append("-lc")
        args.append(command_str)
    else:
        args.extend(["--"])
        args.extend(command_list)
    return args


def exec_pod(
    pod: str,
    namespace: str,
    container: Optional[str],
    command_str: str,
    allow_shell: bool,
) -> dict:
    if not allow_shell and contains_forbidden_metachrs(command_str):
        return {
            "ok": False,
            "error": "셸 메타문자가 포함됨. --allow-shell 플래그 필요.",
            "pod": pod,
            "namespace": namespace,
        }

    try:
        command_list = shlex.split(command_str)
        if not command_list:
            return {"ok": False, "error": "명령어가 비어 있음", "pod": pod, "namespace": namespace}
    except ValueError as e:
        return {"ok": False, "error": f"명령 파싱 오류: {e}", "pod": pod, "namespace": namespace}

    args = build_kubectl_args(pod, namespace, container, command_str, command_list, allow_shell)

    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        return {"ok": False, "error": "kubectl을 찾을 수 없음", "pod": pod, "namespace": namespace}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "30초 타임아웃", "pod": pod, "namespace": namespace}

    return {
        "success": result.returncode == 0,
        "ok": result.returncode == 0,
        "pod": pod,
        "namespace": namespace,
        "container": container or "default",
        "command": command_list,
        "commandText": command_str,
        "output": result.stdout,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "returncode": result.returncode,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Kubernetes Pod 내 명령 실행",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""예시:
  %(prog)s -p myapp-pod -n production -cmd "ls /app"
  %(prog)s -p myapp-pod -n production -c sidecar -cmd "cat /etc/hosts"
  %(prog)s -p myapp-pod -n production -cmd "ls | grep nginx" --allow-shell""" ,
    )
    parser.add_argument("-p", "--pod", required=True, help="Pod 이름")
    parser.add_argument("-n", "--namespace", default="default", help="네임스페이스")
    parser.add_argument("-c", "--container", help="컨테이너 이름")
    parser.add_argument("-cmd", "--command", required=True, help="실행할 명령")
    parser.add_argument("--allow-shell", action="store_true", help="셸 메타문자 허용")

    args = parser.parse_args()
    result = exec_pod(
        pod=args.pod,
        namespace=args.namespace,
        container=args.container,
        command_str=args.command,
        allow_shell=args.allow_shell,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
