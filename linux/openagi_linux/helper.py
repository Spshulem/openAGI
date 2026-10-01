from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path

from .rpc import MAX_REQUEST_BYTES, RpcClient


def socket_path() -> Path:
    configured = os.environ.get("OPENAGI_LINUX_SOCKET")
    if configured:
        path = Path(configured)
    else:
        runtime = os.environ.get("XDG_RUNTIME_DIR")
        if not runtime:
            raise RuntimeError("XDG_RUNTIME_DIR is unavailable")
        path = Path(runtime) / "openagi-linux-companion.sock"
    if not path.is_absolute() or len(str(path).encode("utf-8")) > 4_096:
        raise RuntimeError("companion socket path is invalid")
    return path


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        sys.stderr.write("openagi-linux-helper: exactly one operation is required\n")
        return 2
    operation = args[0]
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("payload too large")
        payload = json.loads(raw) if raw else {}
        if not isinstance(payload, dict):
            raise ValueError("payload is not an object")
        action_id = os.environ.get("OPENAGI_LINUX_ACTION_ID") or str(uuid.uuid4())
        raw_deadline = os.environ.get("OPENAGI_LINUX_DEADLINE_MS")
        deadline_ms = int(raw_deadline) if raw_deadline else int(time.time() * 1000) + 15_000
        authority_values = {
            "leaseId": os.environ.get("OPENAGI_LINUX_LEASE_ID"),
            "actionId": os.environ.get("OPENAGI_LINUX_APPROVAL_ACTION_ID"),
            "sequence": os.environ.get("OPENAGI_LINUX_SEQUENCE"),
            "expiresAtMs": os.environ.get("OPENAGI_LINUX_LEASE_EXPIRES_MS"),
        }
        present = [value is not None for value in authority_values.values()]
        if any(present) and not all(present):
            raise ValueError("incomplete node lease authority")
        authorization = None
        if all(present):
            authorization = {
                "leaseId": str(authority_values["leaseId"]),
                "actionId": str(authority_values["actionId"]),
                "sequence": int(str(authority_values["sequence"])),
                "expiresAtMs": int(str(authority_values["expiresAtMs"])),
            }
        response = RpcClient(socket_path()).call(
            {"action": operation, "payload": payload},
            action_id=action_id,
            deadline_epoch_ms=deadline_ms,
            authorization=authorization,
        )
        if not response.get("ok"):
            error = response.get("error") if isinstance(response.get("error"), dict) else {}
            code = str(error.get("code") or "operation_failed")[:100]
            message = str(error.get("message") or "computer operation failed")[:300]
            sys.stderr.write(f"openagi-linux-helper: {code}: {message}\n")
            return 1
        sys.stdout.write(json.dumps(response.get("result", {}), ensure_ascii=False, separators=(",", ":")))
        return 0
    except BaseException:
        sys.stderr.write("openagi-linux-helper: companion request failed\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
