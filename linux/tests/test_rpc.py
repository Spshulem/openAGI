import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.rpc import RpcClient, RpcServer


class RpcTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.socket_path = Path(self.temp.name) / "companion.sock"
        self.requests = []
        self.contexts = []

        def handler(request, context=None):
            self.requests.append(request)
            self.contexts.append(context)
            if request["action"] == "status":
                return {"ok": True, "capabilities": {"screenshot": True}}
            if request["action"] == "type":
                return {"ok": True, "result": {"ok": True}}
            return {"ok": False, "error": {"code": "unsupported_operation", "message": "not supported"}}

        self.server = RpcServer(self.socket_path, handler=handler)
        self.server.start()

    def tearDown(self):
        self.server.close()
        self.temp.cleanup()

    def test_same_user_unix_socket_round_trip_and_private_mode(self):
        response = RpcClient(self.socket_path).call({"action": "status", "payload": {}})
        self.assertTrue(response["ok"])
        self.assertEqual(self.requests, [{"action": "status", "payload": {}}])
        self.assertEqual(os.stat(self.socket_path).st_mode & 0o777, 0o600)

    def test_idle_same_uid_client_cannot_block_later_requests(self):
        self.server.close()
        self.server = RpcServer(
            self.socket_path,
            handler=lambda _request, _context: {"ok": True},
            request_read_timeout_seconds=1.0,
        )
        self.server.start()
        idle_clients = [socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) for _ in range(4)]
        for idle in idle_clients:
            self.addCleanup(idle.close)
            idle.connect(str(self.socket_path))
        time.sleep(0.05)

        started = time.monotonic()
        response = RpcClient(self.socket_path, timeout_seconds=0.5).call(
            {"action": "status", "payload": {}}
        )

        self.assertTrue(response["ok"])
        self.assertLess(time.monotonic() - started, 0.5)

    def test_concurrent_client_limit_rejects_excess_connections_promptly(self):
        self.server.close()
        self.server = RpcServer(
            self.socket_path,
            handler=lambda _request, _context: {"ok": True},
            request_read_timeout_seconds=1.0,
            max_concurrent_clients=2,
        )
        self.server.start()
        idle_clients = [socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) for _ in range(2)]
        for idle in idle_clients:
            self.addCleanup(idle.close)
            idle.connect(str(self.socket_path))
        time.sleep(0.05)

        started = time.monotonic()
        response = RpcClient(self.socket_path, timeout_seconds=0.5).call(
            {"action": "status", "payload": {}}
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "server_busy")
        self.assertLess(time.monotonic() - started, 0.5)

    def test_request_contract_rejects_unknown_fields_and_oversized_values(self):
        client = RpcClient(self.socket_path)
        with self.assertRaisesRegex(ValueError, "fields"):
            client.call({"action": "status", "payload": {}, "secret": "must-not-pass"})
        with self.assertRaisesRegex(ValueError, "too large"):
            client.call({"action": "type", "payload": {"text": "x" * (1024 * 1024)}})

    def test_same_uid_peer_outside_the_authorized_service_is_rejected(self):
        self.server.close()
        self.server = RpcServer(
            self.socket_path,
            handler=lambda _request, _context: {"ok": True},
            peer_authorizer=lambda _pid: False,
        )
        self.server.start()

        authority = {
            "leaseId": "culease_outside",
            "actionId": "action_outside",
            "sequence": 1,
            "expiresAtMs": int(time.time() * 1000) + 5_000,
        }
        response = RpcClient(self.socket_path).call(
            {"action": "click", "payload": {"x": 1, "y": 1}},
            authorization=authority,
            deadline_epoch_ms=authority["expiresAtMs"] - 1,
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "access_denied")
        self.assertEqual(self.requests, [])

    def test_handler_failure_is_mapped_without_traceback_or_request_echo(self):
        self.server.close()

        def failing(_request, _context=None):
            raise RuntimeError("private detail")

        self.server = RpcServer(self.socket_path, handler=failing)
        self.server.start()
        response = RpcClient(self.socket_path).call({"action": "status", "payload": {}})
        self.assertEqual(response["error"]["code"], "internal_error")
        serialized = json.dumps(response)
        self.assertNotIn("private detail", serialized)
        self.assertNotIn("traceback", serialized.casefold())

    def test_expired_request_is_rejected_before_dispatch(self):
        response = RpcClient(self.socket_path).call(
            {"action": "status", "payload": {}},
            deadline_epoch_ms=1,
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "request_expired")
        self.assertEqual(self.requests, [])

    def test_control_action_requires_and_preserves_node_lease_authority(self):
        client = RpcClient(self.socket_path)
        denied = client.call({"action": "type", "payload": {"text": "bounded"}})
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"]["code"], "approval_required")
        approval = {
            "leaseId": "culease_123",
            "actionId": "action_7",
            "sequence": 7,
            "expiresAtMs": int(time.time() * 1000) + 5_000,
        }

        accepted = client.call(
            {"action": "type", "payload": {"text": "bounded"}},
            authorization=approval,
            deadline_epoch_ms=approval["expiresAtMs"] - 1,
        )

        self.assertTrue(accepted["ok"])
        self.assertEqual(self.contexts[-1].authorization, approval)

    def test_client_disconnect_cancels_an_inflight_request(self):
        self.server.close()
        entered = threading.Event()
        cancelled = threading.Event()

        def blocking(_request, context=None):
            if context is None:
                return {"ok": False, "error": {"code": "missing_context", "message": "missing"}}
            entered.set()
            if context.cancelled.wait(timeout=2):
                cancelled.set()
            return {"ok": False, "error": {"code": "cancelled", "message": "cancelled"}}

        self.server = RpcServer(self.socket_path, handler=blocking)
        self.server.start()
        wire = {
            "action": "type",
            "payload": {"text": "private"},
            "meta": {
                "actionId": str(uuid.uuid4()),
                "deadlineMs": int(time.time() * 1000) + 5_000,
                "authorization": {
                    "leaseId": "culease_disconnect",
                    "actionId": "action_disconnect",
                    "sequence": 1,
                    "expiresAtMs": int(time.time() * 1000) + 5_000,
                },
            },
        }
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(str(self.socket_path))
        client.sendall(json.dumps(wire).encode("utf-8") + b"\n")
        client.shutdown(socket.SHUT_WR)
        self.assertTrue(entered.wait(timeout=1))
        client.close()
        self.assertTrue(cancelled.wait(timeout=1))


if __name__ == "__main__":
    unittest.main()
