import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.capture import CapturePipeline, FocusSnapshot, Frame, PrivacyPolicy
from openagi_linux.client import CompanionConfig
from openagi_linux.ocr import OcrResult, TesseractOcr
from openagi_linux.outbox import ObservationOutbox


class FakeOcr:
    def __init__(self, result=OcrResult(text="Quarterly roadmap", confidence=0.91)):
        self.result = result
        self.calls = []

    def recognize(self, png):
        self.calls.append(png)
        return self.result


class CapturePipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.outbox = ObservationOutbox(Path(self.temp.name) / "outbox.sqlite3")
        self.focus = FocusSnapshot(
            window_id="7",
            pid=42,
            app_id="org.kde.kate",
            app_name="Kate",
            title="Roadmap — Kate",
            x=10,
            y=20,
            width=800,
            height=600,
            observed_at="2026-09-24T18:00:00.000Z",
        )
        self.frame = Frame(png=b"\x89PNG\r\n\x1a\nfixture", width=800, height=600)

    def tearDown(self):
        self.outbox.close()
        self.temp.cleanup()

    def test_excluded_focus_never_reaches_ocr_or_outbox(self):
        ocr = FakeOcr()
        pipeline = CapturePipeline(
            machine_id="linux-a",
            policy=PrivacyPolicy(),
            ocr=ocr,
            outbox=self.outbox,
            sender=lambda envelope: True,
        )
        excluded = FocusSnapshot(**{**self.focus.__dict__, "app_id": "org.keepassxc.KeePassXC"})

        result = pipeline.process(excluded, self.frame)

        self.assertEqual(result.status, "skipped")
        self.assertEqual(result.reason, "privacy-excluded")
        self.assertEqual(ocr.calls, [])
        self.assertEqual(self.outbox.pending_count(), 0)

    def test_sensitive_browser_titles_are_excluded_before_capture(self):
        policy = PrivacyPolicy()

        for title in (
            "WhatsApp — Google Chrome",
            "Vaults | 1Password — Mozilla Firefox",
            "Accounts — Chase — Google Chrome",
        ):
            with self.subTest(title=title):
                browser = FocusSnapshot(
                    **{
                        **self.focus.__dict__,
                        "app_id": "google-chrome",
                        "app_name": "Google Chrome",
                        "title": title,
                    }
                )

                self.assertEqual(policy.reason(browser), "privacy-excluded")

    def test_unknown_focus_fails_closed(self):
        ocr = FakeOcr()
        pipeline = CapturePipeline(
            machine_id="linux-a",
            policy=PrivacyPolicy(),
            ocr=ocr,
            outbox=self.outbox,
            sender=lambda envelope: True,
        )
        unknown = FocusSnapshot(**{**self.focus.__dict__, "app_id": "", "title": ""})

        result = pipeline.process(unknown, self.frame)

        self.assertEqual((result.status, result.reason), ("skipped", "focus-unverified"))
        self.assertEqual(ocr.calls, [])

    def test_success_sends_only_metadata_and_ocr_text(self):
        sent = []
        ocr = FakeOcr()
        pipeline = CapturePipeline(
            machine_id="linux-a",
            policy=PrivacyPolicy(),
            ocr=ocr,
            outbox=self.outbox,
            sender=lambda envelope: sent.append(envelope) or True,
        )

        result = pipeline.process(self.focus, self.frame)

        self.assertEqual(result.status, "sent")
        self.assertEqual(ocr.calls, [self.frame.png])
        self.assertEqual(self.outbox.pending_count(), 0)
        self.assertEqual(len(sent), 1)
        envelope = sent[0]
        self.assertEqual(envelope["sourceMachineId"], "linux-a")
        self.assertEqual([row["kind"] for row in envelope["observations"]], ["activity", "frame"])
        self.assertEqual(envelope["observations"][1]["ocrText"], "Quarterly roadmap")
        serialized = json.dumps(envelope)
        self.assertNotIn("base64", serialized)
        self.assertNotIn("thumbnail", serialized)
        self.assertNotIn("fixture", serialized)

    def test_failed_delivery_stays_durable_until_retry_succeeds(self):
        attempts = []

        def sender(envelope):
            attempts.append(envelope)
            return len(attempts) > 1

        pipeline = CapturePipeline(
            machine_id="linux-a",
            policy=PrivacyPolicy(),
            ocr=FakeOcr(),
            outbox=self.outbox,
            sender=sender,
        )

        first = pipeline.process(self.focus, self.frame)
        self.assertEqual(first.status, "queued")
        self.assertEqual(self.outbox.pending_count(), 1)

        flushed = pipeline.flush()
        self.assertEqual(flushed, 1)
        self.assertEqual(self.outbox.pending_count(), 0)
        self.assertEqual(attempts[0], attempts[1])

    def test_activity_and_frame_can_be_delivered_on_independent_cadences(self):
        with tempfile.TemporaryDirectory() as temp:
            outbox = ObservationOutbox(Path(temp) / "outbox.sqlite3")
            self.addCleanup(outbox.close)
            sent = []
            pipeline = CapturePipeline(
                machine_id="linux-node",
                policy=PrivacyPolicy(),
                ocr=FakeOcr(OcrResult(text="Visible text", confidence=0.9)),
                outbox=outbox,
                sender=lambda envelope: sent.append(envelope) is None,
            )

            self.assertEqual(pipeline.process_activity(self.focus).status, "sent")
            self.assertEqual(pipeline.process_frame(self.focus, self.frame).status, "sent")
            self.assertEqual([batch["observations"][0]["kind"] for batch in sent], ["activity", "frame"])

    def test_outbox_prunes_oldest_batches_to_bounded_rows_and_bytes(self):
        now = [1_000.0]
        with tempfile.TemporaryDirectory() as temp:
            outbox = ObservationOutbox(
                Path(temp) / "outbox.sqlite3",
                max_batches=2,
                max_total_bytes=400,
                max_age_seconds=60,
                clock=lambda: now[0],
            )
            try:
                for index in range(3):
                    outbox.enqueue({"sourceMachineId": "linux", "observations": [{"index": index, "text": "x" * 80}]})
                self.assertEqual(outbox.pending_count(), 2)
                self.assertGreaterEqual(outbox.dropped_count, 1)
                delivered = []
                self.assertEqual(outbox.flush(lambda envelope: delivered.append(envelope) or True), 2)
                self.assertEqual([item["observations"][0]["index"] for item in delivered], [1, 2])

                outbox.enqueue({"sourceMachineId": "linux", "observations": [{"index": 4}]})
                now[0] += 61
                self.assertEqual(outbox.pending_count(), 0)
            finally:
                outbox.close()

    def test_outbox_byte_quota_counts_utf8_bytes_not_characters(self):
        with tempfile.TemporaryDirectory() as temp:
            outbox = ObservationOutbox(
                Path(temp) / "outbox.sqlite3",
                max_batches=10,
                max_total_bytes=600,
            )
            envelope = {
                "sourceMachineId": "linux",
                "observations": [{"kind": "frame", "ocrText": "🔐" * 100}],
            }
            try:
                outbox.enqueue({**envelope, "sequence": 1})
                outbox.enqueue({**envelope, "sequence": 2})

                self.assertEqual(outbox.pending_count(), 1)
                self.assertEqual(outbox.dropped_count, 1)
            finally:
                outbox.close()

    def test_clear_context_removes_private_text_from_sqlite_file_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "outbox.sqlite3"
            sentinel = "OPENAGI_PRIVATE_OCR_SENTINEL_7f83b3"
            outbox = ObservationOutbox(path)
            try:
                outbox.enqueue({
                    "sourceMachineId": "linux-test",
                    "observations": [{"kind": "frame", "ocrText": sentinel}],
                })
                self.assertIn(sentinel.encode(), path.read_bytes())
                self.assertEqual(outbox.clear(), 1)
            finally:
                outbox.close()

            self.assertNotIn(sentinel.encode(), path.read_bytes())


class ConfigTests(unittest.TestCase):
    def test_loopback_http_is_allowed_but_remote_http_is_rejected(self):
        local = CompanionConfig(base_url="http://127.0.0.1:43210", auth_token=None)
        self.assertEqual(local.base_url, "http://127.0.0.1:43210")
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            CompanionConfig(base_url="http://192.0.2.10:43210", auth_token="secret")


class TesseractTests(unittest.TestCase):
    def test_png_is_sent_on_stdin_and_tsv_confidence_is_bounded(self):
        calls = []
        tsv = (
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
            "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t95.0\tHola\n"
            "5\t1\t1\t1\t1\t2\t11\t0\t20\t10\t85.0\tmundo\n"
            "5\t1\t1\t1\t1\t3\t32\t0\t20\t10\t-1\tignored\n"
        ).encode()

        def run(args, *, input, capture_output, timeout, check, env):
            calls.append((args, input, capture_output, timeout, check, env))
            return type("Completed", (), {"stdout": tsv, "stderr": b""})()

        ocr = TesseractOcr(executable="/usr/bin/tesseract", run=run)
        private_png = b"\x89PNG\r\n\x1a\n private pixels"
        with patch.dict(os.environ, {
            "OPENAGI_AUTH_TOKEN": "must-not-reach-tesseract",
            "HOME": "/home/tester",
            "LANG": "es_ES.UTF-8",
            "TESSDATA_PREFIX": "/usr/share/tesseract/tessdata",
        }, clear=True):
            result = ocr.recognize(private_png)

        self.assertEqual(result.text, "Hola mundo")
        self.assertAlmostEqual(result.confidence, 0.90)
        args, stdin, capture_output, timeout, check, env = calls[0]
        self.assertEqual(args[:3], ["/usr/bin/tesseract", "stdin", "stdout"])
        self.assertNotIn("tsv", args)
        self.assertIn("tessedit_create_tsv=1", args)
        self.assertNotIn("private", " ".join(args))
        self.assertEqual(stdin, private_png)
        self.assertTrue(capture_output)
        self.assertEqual(timeout, 5)
        self.assertTrue(check)
        self.assertNotIn("OPENAGI_AUTH_TOKEN", env)
        self.assertEqual(env["HOME"], "/home/tester")
        self.assertEqual(env["LANG"], "es_ES.UTF-8")
        self.assertEqual(env["TESSDATA_PREFIX"], "/usr/share/tesseract/tessdata")


if __name__ == "__main__":
    unittest.main()
