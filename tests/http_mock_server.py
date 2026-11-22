"""Scripted loopback HTTP fixtures for Chat Completions transport tests."""

from __future__ import annotations

import json
import threading
from collections import deque
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Self


@dataclass(frozen=True)
class MockResponse:
    status: int = 200
    body: bytes = b""
    headers: Mapping[str, str] = field(default_factory=dict)
    delay_sec: float = 0.0

    @classmethod
    def from_json(
        cls,
        payload: Mapping[str, object],
        *,
        status: int = 200,
        headers: Mapping[str, str] | None = None,
        delay_sec: float = 0.0,
    ) -> Self:
        """Encode a JSON response, optionally delayed before sending headers."""
        response_headers = {"Content-Type": "application/json"}
        if headers is not None:
            response_headers.update(headers)
        return cls(
            status=status,
            body=json.dumps(dict(payload)).encode("utf-8"),
            headers=response_headers,
            delay_sec=delay_sec,
        )


@dataclass(frozen=True)
class RecordedRequest:
    path: str
    headers: dict[str, str]
    body: bytes


class MockChatCompletionsServer:
    """Serve FIFO responses to completion POSTs and record their headers and body.

    Append ``/chat/completions`` or ``/v1/chat/completions`` to ``base_url``.
    A request past the end of the script receives HTTP 503.
    """

    def __init__(self, responses: Iterable[MockResponse]) -> None:
        self._responses = deque(responses)
        self.requests: list[RecordedRequest] = []

    @property
    def base_url(self) -> str:
        """Return the active loopback URL with the ephemeral port."""
        return f"http://127.0.0.1:{self._server.server_port}"

    def __enter__(self) -> Self:
        fixture = self
        lock = threading.Lock()
        stopping = self._stopping = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                if self.path not in ("/chat/completions", "/v1/chat/completions"):
                    self.send_error(404)
                    return
                content_length = int(self.headers.get("Content-Length", "0"))
                request = RecordedRequest(self.path, dict(self.headers.items()), self.rfile.read(content_length))
                with lock:
                    fixture.requests.append(request)
                    response = fixture._responses.popleft() if fixture._responses else None
                if response is None:
                    self.send_error(503, "No scripted response remains")
                    return

                if stopping.wait(response.delay_sec):
                    return
                try:
                    self.send_response(response.status)
                    for key, value in response.headers.items():
                        self.send_header(key, value)
                    self.send_header("Content-Length", str(len(response.body)))
                    self.end_headers()
                    self.wfile.write(response.body)
                except ConnectionError:
                    # A timeout test can close the client before the response is sent.
                    pass

            def log_message(self, format: str, *args: object) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True,
        )
        try:
            self._thread.start()
        except RuntimeError:
            self._server.server_close()
            raise
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stopping.set()
        self._server.shutdown()
        self._thread.join()
        self._server.server_close()
