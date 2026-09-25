from __future__ import annotations

import ipaddress
import json
import uuid
from dataclasses import dataclass
from typing import Callable
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .sse import SseDecoder


@dataclass(frozen=True)
class CompanionConfig:
    base_url: str = "http://127.0.0.1:43210"
    auth_token: str | None = None

    def __post_init__(self) -> None:
        raw = self.base_url.strip().rstrip("/")
        parsed = urlsplit(raw)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("OpenAGI base URL must be an absolute HTTP(S) URL")
        if parsed.username or parsed.password:
            raise ValueError("OpenAGI credentials must not be embedded in the URL")
        if parsed.query or parsed.fragment:
            raise ValueError("OpenAGI base URL must not contain a query or fragment")
        if parsed.path not in {"", "/"}:
            raise ValueError("OpenAGI base URL must not contain a path")
        try:
            host = ipaddress.ip_address(parsed.hostname)
            loopback = host.is_loopback
        except ValueError:
            loopback = parsed.hostname.lower() == "localhost"
        if parsed.scheme != "https" and not loopback:
            raise ValueError("A non-loopback OpenAGI daemon requires HTTPS")
        object.__setattr__(self, "base_url", raw)
        if self.auth_token is not None and (not self.auth_token or len(self.auth_token) > 4096):
            raise ValueError("OpenAGI auth token is invalid")


@dataclass(frozen=True)
class AskResult:
    reply: str
    session_id: str | None


class DaemonClient:
    def __init__(self, config: CompanionConfig, opener=None) -> None:
        self.config = config
        self.opener = opener if opener is not None else build_opener(_NoRedirectHandler())
        self.session_id = "overlay:user:main"

    def push_observations(self, envelope: dict) -> bool:
        _validate_observation_envelope(envelope)
        request = self._request("/observations", envelope, accept="application/json")
        try:
            with self.opener.open(request, timeout=10) as response:
                if not 200 <= int(getattr(response, "status", 0)) < 300:
                    return False
                parsed = json.loads(_read_limited(response, 256 * 1024))
                return isinstance(parsed.get("count"), int)
        except HTTPError as error:
            error.close()
            return False
        except Exception:
            return False

    def ask(
        self,
        text: str,
        *,
        screen_context: dict | None = None,
        on_event: Callable[[str, dict], None] | None = None,
    ) -> AskResult:
        question = str(text).strip()
        if not question or len(question) > 32_000:
            raise ValueError("Quick Ask text is empty or too long")
        metadata: dict = {
            "requestId": f"ask_{uuid.uuid4().hex}",
            "requestSource": "overlay",
        }
        if screen_context:
            metadata["screenContext"] = _normalize_screen_context(screen_context)
        payload = {
            "text": question,
            "channel": "overlay",
            "from": "user",
            "agentId": "main",
            "sessionId": self.session_id,
            "metadata": metadata,
        }
        request = self._request("/message", payload, accept="text/event-stream")
        try:
            response = self.opener.open(request, timeout=120)
        except HTTPError as error:
            error.close()
            raise RuntimeError("OpenAGI rejected the Quick Ask request") from None
        with response:
            if not 200 <= int(getattr(response, "status", 0)) < 300:
                raise RuntimeError("OpenAGI rejected the Quick Ask request")
            content_type = str(response.headers.get("content-type", "")).lower()
            if "text/event-stream" not in content_type:
                return self._decode_final(json.loads(_read_limited(response, 1024 * 1024)))
            decoder = SseDecoder()
            while True:
                chunk = response.read(8192)
                if not chunk:
                    break
                for event in decoder.feed(chunk):
                    try:
                        data = json.loads(event["data"])
                    except json.JSONDecodeError as error:
                        raise RuntimeError("OpenAGI returned malformed stream data") from error
                    name = event["event"]
                    if name in {"status", "heartbeat", "session", "delta"} and on_event:
                        on_event(name, data)
                    if name == "session" and isinstance(data.get("id"), str):
                        self.session_id = data["id"]
                    elif name == "final":
                        return self._decode_final(data)
                    elif name == "failure":
                        if isinstance(data.get("sessionId"), str):
                            self.session_id = data["sessionId"]
                        raise RuntimeError(str(data.get("error") or "OpenAGI could not complete the request")[:500])
        raise RuntimeError("OpenAGI stream ended before a final response")

    def _decode_final(self, data: dict) -> AskResult:
        reply = data.get("reply")
        if not isinstance(reply, str):
            raise RuntimeError("OpenAGI returned an invalid Quick Ask response")
        session = data.get("session")
        if isinstance(session, dict) and isinstance(session.get("id"), str):
            self.session_id = session["id"]
        return AskResult(reply=reply, session_id=self.session_id)

    def _request(self, path: str, payload: dict, *, accept: str) -> Request:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(body) > 2 * 1024 * 1024:
            raise ValueError("OpenAGI request exceeds the transport limit")
        headers = {"Content-Type": "application/json", "Accept": accept}
        if self.config.auth_token:
            headers["Authorization"] = f"Bearer {self.config.auth_token}"
        return Request(self.config.base_url + path, data=body, headers=headers, method="POST")


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _read_limited(response, limit: int) -> bytes:
    out = bytearray()
    while True:
        chunk = response.read(min(8192, limit + 1 - len(out)))
        if not chunk:
            return bytes(out)
        out.extend(chunk)
        if len(out) > limit:
            raise RuntimeError("OpenAGI response exceeded the transport limit")


def _normalize_screen_context(raw: dict) -> dict:
    context = {}
    for key, limit in (("app", 200), ("window", 1_000), ("text", 16_000)):
        value = raw.get(key)
        if value is not None:
            context[key] = str(value)[:limit]
    if not context.get("app") or not context.get("text"):
        raise ValueError("screen context requires app and text")
    return context


def _validate_observation_envelope(envelope: dict) -> None:
    if not isinstance(envelope, dict) or not isinstance(envelope.get("sourceMachineId"), str):
        raise ValueError("invalid observation envelope")
    rows = envelope.get("observations")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 256:
        raise ValueError("invalid observation batch")
    forbidden = {"base64", "image", "imageBytes", "png", "thumbnail", "thumbnailPath"}
    for row in rows:
        if not isinstance(row, dict) or row.get("kind") not in {"activity", "frame"}:
            raise ValueError("invalid observation row")
        if forbidden.intersection(row):
            raise ValueError("raw image data is forbidden in observations")
        for key in ("app", "window", "ocrText"):
            if key in row and (not isinstance(row[key], str) or len(row[key]) > 32_000):
                raise ValueError("observation text is invalid")
