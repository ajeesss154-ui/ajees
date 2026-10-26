"""Small integration hooks; imports never create a database or a Qt widget."""
from __future__ import annotations

import asyncio
from functools import wraps
import re
import time
import uuid

from .store import Store


def _result_status(response):
    """Keep receipts honest: returning prose is not proof an action completed."""
    payload = getattr(response, "response", None)
    if not isinstance(payload, dict):
        return "returned"
    result = payload.get("result")
    if not isinstance(result, str):
        return "returned"
    match = re.match(r"^status=(done|unverified|failed|ask|started)\b", result)
    if match:
        return {"done": "confirmed", "ask": "needs input"}.get(match[1], match[1])
    if re.match(r"^Tool '[^']+' failed:", result) or result.startswith("Unknown tool:"):
        return "failed"
    if result.startswith("[WORKSPACE_ERROR]"):
        return "failed"
    return "returned"


def audit_tool(function):
    @wraps(function)
    async def wrapped(self, fc, *args, **kwargs):
        started = time.monotonic()
        invocation = uuid.uuid4().hex[:12]
        store = None
        event_id = None
        try:
            store = Store()
            name = re.sub(r"[^A-Za-z0-9_.-]", "_", str(getattr(fc, "name", "tool")))[:120] or "tool"
            event_id = store.log_activity(name, "running", "Invocation " + invocation)
        except Exception:
            pass  # Disk trouble must never prevent an existing assistant action.
        status = "failed"
        try:
            response = await function(self, fc, *args, **kwargs)
            status = _result_status(response)
            return response
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        finally:
            if store is not None and event_id is not None:
                try:
                    elapsed = time.monotonic() - started
                    store.finish_activity(event_id, status, f"Invocation {invocation} / {elapsed:.2f}s. Arguments and reply text are not stored.")
                except Exception:
                    pass
    return wrapped


def install_button(window):
    """Called once from JarvisUI.__init__, on the Qt application thread."""
    from PyQt6.QtCore import QObject, pyqtSignal, pyqtSlot, Qt
    from PyQt6.QtWidgets import QPushButton

    if getattr(window, "_personal_workspace_bridge", None) is not None:
        return

    class WorkspaceBridge(QObject):
        requested = pyqtSignal()

        def __init__(self, parent):
            super().__init__(parent)
            self.requested.connect(self.show_workspace)

        @pyqtSlot()
        def show_workspace(self):
            try:
                from .ui import open_workspace
                open_workspace(parent=window)
            except Exception as exc:
                from PyQt6.QtWidgets import QMessageBox
                QMessageBox.warning(window, "Workspace unavailable", "The workspace could not open. Your main assistant is still available.\n" + str(exc)[:400])

    bridge = WorkspaceBridge(window)
    header = window.centralWidget().layout().itemAt(0).widget()
    layout = header.layout()
    index = layout.indexOf(window._ctrl_btn)
    if index < 0:
        raise RuntimeError("Unsupported JARVIS header layout.")
    button = QPushButton("WORKSPACE", header)
    button.setObjectName("personalWorkspaceButton")
    button.setAccessibleName("Open Personal Workspace")
    button.setToolTip("Routines, project memory, and action history")
    button.setCursor(Qt.CursorShape.PointingHandCursor)
    button.setStyleSheet("QPushButton { color:#73ead8; background:#092331; border:1px solid #246373; border-radius:4px; padding:5px 8px; font:10px 'Segoe UI'; } QPushButton:hover { background:#163b49; }")
    button.clicked.connect(lambda _checked=False: bridge.requested.emit())
    layout.insertWidget(index + 1, button)
    window._personal_workspace_bridge = bridge


def request_workspace(player):
    """Emit to the Qt thread; a tool executor never constructs a QWidget."""
    bridge = getattr(getattr(player, "_win", None), "_personal_workspace_bridge", None)
    if bridge is None:
        return False
    bridge.requested.emit()
    return True
