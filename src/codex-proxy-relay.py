"""Loopback-only proxy relay inside Codex's network namespace.

This process does not resolve destinations or make outbound IP connections. The
outside broker authorizes the CONNECT target and performs DNS resolution.
"""

import os
import selectors
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
from typing import cast

SOCKET = "/profile/egress.sock"
PROXY = "http://127.0.0.1:18787"


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.request.settimeout(5)
            with socket.socket(socket.AF_UNIX) as upstream:
                upstream.settimeout(5)
                upstream.connect(SOCKET)
                deadline = time.monotonic() + 180
                with selectors.DefaultSelector() as selector:
                    selector.register(self.request, selectors.EVENT_READ, upstream)
                    selector.register(upstream, selectors.EVENT_READ, self.request)
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            return
                        events = selector.select(min(30, remaining))
                        if not events:
                            return
                        for key, _ in events:
                            chunk = cast(socket.socket, key.fileobj).recv(65536)
                            if not chunk:
                                return
                            key.data.sendall(chunk)
        except (OSError, TimeoutError):
            return


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    request_queue_size = 8
    allow_reuse_address = False

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            cast(socket.socket, request).close()
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def main():
    os.environ["HTTPS_PROXY"] = PROXY
    os.environ["https_proxy"] = PROXY
    with Server(("127.0.0.1", 18787), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        child = subprocess.Popen(["/opt/codex", *sys.argv[1:]], close_fds=True)
        def terminate(_signal, _frame):
            child.terminate()
        signal.signal(signal.SIGTERM, terminate)
        signal.signal(signal.SIGINT, terminate)
        try:
            return child.wait()
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            server.shutdown()
            thread.join(timeout=2)


if __name__ == "__main__":
    sys.exit(main())
