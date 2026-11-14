"""Minimal JSON-over-HTTP client (stdlib only) for the live tests."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass
class Reply:
    status: int
    content_type: str
    text: str

    @property
    def json(self) -> Any:
        return json.loads(self.text)

    def json_or_none(self) -> Any:
        try:
            return self.json
        except ValueError:
            return None


class Client:
    def __init__(self, base_url: str, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def call(self, method: str, path: str, body: Any = None, raw: bytes | None = None) -> Reply:
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        if data is not None:
            req.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return Reply(
                    resp.status, resp.headers.get("content-type", ""), resp.read().decode()
                )
        except urllib.error.HTTPError as e:
            return Reply(e.code, e.headers.get("content-type", ""), e.read().decode())

    def get(self, path: str) -> Reply:
        return self.call("GET", path)

    def post(self, path: str, body: Any = None, raw: bytes | None = None) -> Reply:
        return self.call("POST", path, body, raw)

    def reachable(self, path: str = "/health") -> tuple[bool, str]:
        try:
            r = self.call("GET", path)
        except (urllib.error.URLError, OSError) as e:
            return False, f"{self.base_url}{path} unreachable ({getattr(e, 'reason', e)})"
        return True, f"{self.base_url}{path} answered HTTP {r.status}"
