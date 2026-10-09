"""Conexões WebSocket e broadcast coalescido do estado."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket


class Hub:
    def __init__(self, build_state: Callable[[], dict[str, Any]]) -> None:
        self._build_state = build_state
        self._clients: set[WebSocket] = set()
        self._dirty = False
        self._task: asyncio.Task | None = None
        self.loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)
        await ws.send_text(json.dumps({"type": "state", "state": self._build_state()}))

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    def notify(self) -> None:
        """Agenda um broadcast do estado completo (coalescido em ~50 ms)."""
        self._dirty = True
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._flush())

    def notify_threadsafe(self) -> None:
        if self.loop:
            self.loop.call_soon_threadsafe(self.notify)

    async def send(self, message: dict[str, Any]) -> None:
        data = json.dumps(message)
        dead: list[WebSocket] = []
        for ws in list(self._clients):
            try:
                await ws.send_text(data)
            except Exception:  # noqa: BLE001 - qualquer falha de envio derruba o cliente
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    async def _flush(self) -> None:
        await asyncio.sleep(0.05)
        while self._dirty:
            self._dirty = False
            await self.send({"type": "state", "state": self._build_state()})
