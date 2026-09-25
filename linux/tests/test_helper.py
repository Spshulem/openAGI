import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.rpc import RpcServer


class HelperProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.socket_path = Path(self.temp.name) / "companion.sock"
        self.requests = []
        self.contexts = []

        def handler(request, context):
            self.requests.append(request)
            self.contexts.append(context)
            if request["action"] == "status":
                return {"ok": True, "result": {"screenshotReady": True, "operations": ["type"]}}
            if request["action"] == "type":
                return {"ok": True, "result": {"ok": True}}
            return {"ok": False, "error": {"code": "unsupported_operation", "message": "unsupported"}}

        self.server = RpcServer(self.socket_path, handler=handler)
        self.server.start()
        self.linux_root = Path(__file__).resolve().parents[1]
        self.env = {**os.environ, "OPENAGI_LINUX_SOCKET": str(self.socket_path), "PYTHONPATH": str(self.linux_root)}

    def tearDown(self):
        self.server.close()
        self.temp.cleanup()

    def run_helper(self, operation, payload=b"", *, authorization=None):
        env = dict(self.env)
        if authorization is not None:
            env.update({
                "OPENAGI_LINUX_LEASE_ID": authorization["leaseId"],
                "OPENAGI_LINUX_APPROVAL_ACTION_ID": authorization["actionId"],
                "OPENAGI_LINUX_SEQUENCE": str(authorization["sequence"]),
                "OPENAGI_LINUX_LEASE_EXPIRES_MS": str(authorization["expiresAtMs"]),
            })
        return subprocess.run(
            [sys.executable, "-m", "openagi_linux.helper", operation],
            cwd=self.linux_root,
            env=env,
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
            check=False,
        )

    def test_helper_unwraps_status_for_the_existing_node_contract(self):
        process = self.run_helper("status")
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout), {"screenshotReady": True, "operations": ["type"]})
        self.assertEqual(self.requests, [{"action": "status", "payload": {}}])

    def test_sensitive_payload_travels_over_stdin_and_errors_never_echo_it(self):
        secret_text = "text-that-must-not-appear-in-errors"
        authorization = {
            "leaseId": "culease_helper",
            "actionId": "action_helper",
            "sequence": 3,
            "expiresAtMs": 9_007_199_254_740_000,
        }
        process = self.run_helper(
            "type",
            json.dumps({"text": secret_text}).encode(),
            authorization=authorization,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(self.requests[-1]["payload"]["text"], secret_text)
        self.assertEqual(self.contexts[-1].authorization, authorization)
        self.assertNotIn(secret_text, " ".join(process.args))

        denied = self.run_helper("paste", json.dumps({"text": secret_text}).encode(), authorization=authorization)
        self.assertNotEqual(denied.returncode, 0)
        self.assertNotIn(secret_text.encode(), denied.stderr)
        self.assertEqual(denied.stdout, b"")


if __name__ == "__main__":
    unittest.main()
