"""Local desktop workspace for JARVIS. Run with python -m personal_workspace.ui."""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from typing import Any

from PyQt6.QtCore import Qt, QThread, QTimer, pyqtSignal
from PyQt6.QtWidgets import (
    QApplication, QComboBox, QDialog, QFormLayout, QHBoxLayout, QLabel,
    QLineEdit, QListWidget, QListWidgetItem, QMessageBox, QPushButton,
    QSplitter, QTabWidget, QTableWidget, QTableWidgetItem, QTextEdit,
    QVBoxLayout, QWidget, QHeaderView, QAbstractItemView,
)

from .store import Store, run_routine

_STYLE = """
QDialog, QWidget { background: #08151d; color: #dcecf1; font-family: 'Segoe UI'; font-size: 12px; }
QLabel#heading { color: #57e1ed; font-size: 23px; font-weight: 600; }
QLabel#subtitle, QLabel#help { color: #91a8b4; }
QLabel#result { background: #102832; border: 1px solid #234c5b; border-radius: 6px; padding: 10px; }
QTabWidget::pane { border: 1px solid #244453; border-radius: 6px; }
QTabBar::tab { background: #10232e; padding: 12px 22px; color: #9db7c1; }
QTabBar::tab:selected { color: #57e1ed; border-bottom: 2px solid #57e1ed; }
QLineEdit, QTextEdit, QListWidget, QTableWidget { background: #0c202a; border: 1px solid #284954; border-radius: 4px; padding: 7px; selection-background-color: #1a5263; }
QLineEdit:focus, QTextEdit:focus { border-color: #57e1ed; }
QListWidget::item { padding: 11px 6px; border-bottom: 1px solid #183541; }
QListWidget::item:selected { background: #174653; color: #9af5f4; }
QPushButton { border: 1px solid #315461; background: #132e3b; padding: 9px 14px; border-radius: 4px; }
QPushButton:hover { border-color: #57e1ed; background: #194253; }
QPushButton:disabled { color: #65808b; background: #10232b; }
QPushButton#primary { background: #3dd3de; color: #05212a; border: 1px solid #3dd3de; font-weight: 600; }
QPushButton#danger { color: #f4b2b2; }
QComboBox { background: #132e3b; border: 1px solid #315461; padding: 6px; }
QComboBox QAbstractItemView { background: #132e3b; color: #dcecf1; selection-background-color: #1a5263; }
QHeaderView::section { background: #102832; color: #98c7d3; padding: 8px; border: 0; }
QTableWidget { gridline-color: #244453; }
QSplitter::handle { background: #183541; width: 3px; }
"""
_WINDOWS: list[WorkspaceWindow] = []
_WORKERS: set[RoutineWorker] = set()


def _button(text: str, callback, primary: bool = False, danger: bool = False) -> QPushButton:
    button = QPushButton(text)
    button.setAutoDefault(False)
    if primary:
        button.setObjectName("primary")
    elif danger:
        button.setObjectName("danger")
    button.clicked.connect(callback)
    return button


def _help(text: str) -> QLabel:
    label = QLabel(text)
    label.setObjectName("help")
    label.setWordWrap(True)
    return label


def _local_timestamp(value) -> str:
    text = str(value or "")
    try:
        timestamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            # Store timestamps are UTC, including legacy values lacking an offset.
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        return timestamp.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    except (ValueError, TypeError, OverflowError, OSError):
        return text


class RoutineWorker(QThread):
    completed = pyqtSignal(object)
    failed = pyqtSignal(str)

    def __init__(self, store: Store, routine_id: int):
        super().__init__()
        self.store = store
        self.routine_id = routine_id

    def run(self):
        try:
            self.completed.emit(run_routine(self.store, self.routine_id))
        except Exception as exc:
            self.failed.emit(str(exc))


class WorkspaceWindow(QDialog):
    def __init__(self, parent=None, store: Store | None = None):
        super().__init__(parent)
        self.store = store or Store()
        self.project_id: int | None = None
        self.routine_id: int | None = None
        self.project_dirty = False
        self.routine_dirty = False
        self._loading = False
        self._projects: dict[int, dict[str, Any]] = {}
        self._routines: dict[int, dict[str, Any]] = {}
        self._worker: RoutineWorker | None = None
        self._activity_signature = None
        self.setWindowTitle("JARVIS · Personal Workspace")
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
        self.resize(1040, 720)
        self.setMinimumSize(760, 560)
        self.setStyleSheet(_STYLE)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        heading = QLabel("PERSONAL WORKSPACE")
        heading.setObjectName("heading")
        layout.addWidget(heading)
        subtitle = QLabel("Your routines. Your project notes. A clear record of actions.")
        subtitle.setObjectName("subtitle")
        layout.addWidget(subtitle)
        self.tabs = QTabWidget()
        layout.addWidget(self.tabs, 1)
        self._build_routines()
        self._build_projects()
        self._build_activity()
        layout.addWidget(_help("Stored locally on this PC. Project notes are separate from JARVIS’s automatic conversation memory."))
        self._load_projects()
        self._load_routines()
        self.refresh_activity()
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.refresh_activity)
        self._timer.start(3000)

    def _error(self, title: str, exc):
        QMessageBox.warning(self, title, str(exc))

    def _build_projects(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.addWidget(_help("Keep a project brief, decisions, and next steps. Save changes before asking JARVIS to recall them."))
        split = QSplitter(Qt.Orientation.Horizontal)
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 8, 0)
        self.project_search = QLineEdit()
        self.project_search.setPlaceholderText("Search project titles and notes…")
        self.project_search.textChanged.connect(self._filter_projects)
        left_layout.addWidget(self.project_search)
        self.project_list = QListWidget()
        self.project_list.currentItemChanged.connect(self._select_project)
        left_layout.addWidget(self.project_list)
        left_layout.addWidget(_button("Refresh projects", self.refresh_projects))
        left_layout.addWidget(_button("+ New project", self.new_project))
        split.addWidget(left)
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(8, 0, 0, 0)
        form = QFormLayout()
        self.project_title = QLineEdit()
        self.project_title.setMaxLength(120)
        self.project_title.setPlaceholderText("e.g. Website redesign")
        self.project_title.textChanged.connect(self._project_changed)
        form.addRow("Project title", self.project_title)
        right_layout.addLayout(form)
        right_layout.addWidget(QLabel("Project memory"))
        self.project_notes = QTextEdit()
        self.project_notes.setAcceptRichText(False)
        self.project_notes.setPlaceholderText("Goal:\n\nDecisions:\n\nNext steps:")
        self.project_notes.textChanged.connect(self._project_changed)
        right_layout.addWidget(self.project_notes, 1)
        self.project_state = _help("New project · not saved yet")
        right_layout.addWidget(self.project_state)
        buttons = QHBoxLayout()
        buttons.addWidget(_button("Save project", self.save_project, primary=True))
        buttons.addStretch()
        buttons.addWidget(_button("Delete project", self.delete_project, danger=True))
        right_layout.addLayout(buttons)
        split.addWidget(right)
        split.setSizes([270, 650])
        layout.addWidget(split, 1)
        self.tabs.addTab(page, "Project Memory")

    def _build_routines(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.addWidget(_help("Build a sequence of app, website, and folder launches. Supported app names: notepad, calculator, paint, explorer."))
        split = QSplitter(Qt.Orientation.Horizontal)
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 8, 0)
        self.routine_list = QListWidget()
        self.routine_list.currentItemChanged.connect(self._select_routine)
        left_layout.addWidget(self.routine_list)
        left_layout.addWidget(_button("+ New routine", self.new_routine))
        split.addWidget(left)
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(8, 0, 0, 0)
        form = QFormLayout()
        self.routine_name = QLineEdit()
        self.routine_name.setMaxLength(120)
        self.routine_name.setPlaceholderText("e.g. Work mode")
        self.routine_name.textChanged.connect(self._routine_changed)
        form.addRow("Routine name", self.routine_name)
        right_layout.addLayout(form)
        self.step_table = QTableWidget(0, 2)
        self.step_table.setHorizontalHeaderLabels(["Step type", "App, URL, or folder path"])
        self.step_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        self.step_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.step_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.step_table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        right_layout.addWidget(self.step_table, 1)
        step_buttons = QHBoxLayout()
        step_buttons.addWidget(_button("+ Add step", self.add_step))
        step_buttons.addWidget(_button("Remove selected step", self.remove_step))
        step_buttons.addStretch()
        right_layout.addLayout(step_buttons)
        self.routine_state = _help("New routine · not saved yet")
        right_layout.addWidget(self.routine_state)
        buttons = QHBoxLayout()
        self.save_routine_button = _button("Save routine", self.save_routine, primary=True)
        self.run_button = _button("Run saved routine", self.run_selected_routine)
        buttons.addWidget(self.save_routine_button)
        buttons.addWidget(self.run_button)
        buttons.addStretch()
        self.delete_routine_button = _button("Delete", self.delete_routine, danger=True)
        buttons.addWidget(self.delete_routine_button)
        right_layout.addLayout(buttons)
        self.run_result = QLabel("Launches are requests to Windows. Check the opened app or page to verify the result.")
        self.run_result.setObjectName("result")
        self.run_result.setWordWrap(True)
        right_layout.addWidget(self.run_result)
        split.addWidget(right)
        split.setSizes([270, 650])
        layout.addWidget(split, 1)
        self.tabs.addTab(page, "Routines")

    def _build_activity(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.addWidget(_help("Recent tool calls and routine launches. “Requested” means a launch was handed to Windows; “done” is reported by the underlying tool. History does not replay or undo actions."))
        bar = QHBoxLayout()
        self.activity_state = _help("Refreshing…")
        bar.addWidget(self.activity_state, 1)
        bar.addWidget(_button("Refresh", lambda: self.refresh_activity(force=True)))
        bar.addWidget(_button("Clear history", self.clear_activity, danger=True))
        layout.addLayout(bar)
        self.activity_table = QTableWidget(0, 4)
        self.activity_table.setHorizontalHeaderLabels(["Time", "Action", "Status", "Details"])
        self.activity_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.activity_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.activity_table.setAlternatingRowColors(False)
        for column in (0, 1, 2):
            self.activity_table.horizontalHeader().setSectionResizeMode(column, QHeaderView.ResizeMode.ResizeToContents)
        self.activity_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        layout.addWidget(self.activity_table, 1)
        self.tabs.addTab(page, "Activity")

    def _project_changed(self, *_):
        if not self._loading:
            self.project_dirty = True
            self.project_state.setText("Unsaved changes")

    def _routine_changed(self, *_):
        if not self._loading:
            self.routine_dirty = True
            self.routine_state.setText("Unsaved changes")

    def _confirm_unsaved(self, kind: str) -> bool:
        dirty = self.project_dirty if kind == "project" else self.routine_dirty
        if not dirty:
            return True
        answer = QMessageBox.question(
            self, "Unsaved changes", f"Save changes to this {kind} before continuing?",
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Save,
        )
        if answer == QMessageBox.StandardButton.Cancel:
            return False
        if answer == QMessageBox.StandardButton.Save:
            return self.save_project() if kind == "project" else self.save_routine()
        return True

    def _restore_selection(self, widget: QListWidget, record_id):
        widget.blockSignals(True)
        widget.setCurrentItem(None)
        for row in range(widget.count()):
            item = widget.item(row)
            if item.data(Qt.ItemDataRole.UserRole) == record_id:
                widget.setCurrentItem(item)
                break
        widget.blockSignals(False)

    def _load_projects(self):
        try:
            rows = self.store.list_projects()
        except Exception as exc:
            self._error("Could not load projects", exc)
            return False
        self._projects = {row["id"]: row for row in rows}
        self.project_list.blockSignals(True)
        self.project_list.clear()
        for row in rows:
            item = QListWidgetItem(row["title"])
            item.setData(Qt.ItemDataRole.UserRole, row["id"])
            self.project_list.addItem(item)
        self.project_list.blockSignals(False)
        self._restore_selection(self.project_list, self.project_id)
        self._filter_projects(self.project_search.text())
        return True

    def refresh_projects(self):
        """Pull voice-created notes without overwriting unsaved editor changes."""
        if not self._confirm_unsaved("project"):
            return
        if not self._load_projects():
            return
        self._fill_project(self._projects.get(self.project_id))

    def _filter_projects(self, query: str):
        query = query.strip().casefold()
        for i in range(self.project_list.count()):
            item = self.project_list.item(i)
            row = self._projects[item.data(Qt.ItemDataRole.UserRole)]
            item.setHidden(query not in (row["title"] + "\n" + row["notes"]).casefold())

    def _select_project(self, current, _previous):
        if current is None:
            return
        target = current.data(Qt.ItemDataRole.UserRole)
        if target == self.project_id:
            return
        if not self._confirm_unsaved("project"):
            self._restore_selection(self.project_list, self.project_id)
            return
        row = self._projects.get(target)
        if row:
            self._fill_project(row)

    def _fill_project(self, row=None):
        self._loading = True
        self.project_id = row["id"] if row else None
        self.project_title.setText(row["title"] if row else "")
        self.project_notes.setPlainText(row["notes"] if row else "")
        self.project_dirty = False
        self.project_state.setText("Saved · " + str(row["updated_at"]) if row else "New project · not saved yet")
        self._loading = False

    def new_project(self):
        if not self._confirm_unsaved("project"):
            return
        self._restore_selection(self.project_list, None)
        self._fill_project()
        self.project_title.setFocus()

    def save_project(self) -> bool:
        try:
            self.project_id = self.store.save_project(self.project_title.text(), self.project_notes.toPlainText(), self.project_id)
            self.project_dirty = False
            self.project_state.setText("Saved on this PC")
            self._load_projects()
            return True
        except Exception as exc:
            self._error("Could not save project", exc)
            return False

    def delete_project(self):
        if self.project_id is None:
            return
        if QMessageBox.question(self, "Delete project", "Delete this saved project memory?", QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No, QMessageBox.StandardButton.No) != QMessageBox.StandardButton.Yes:
            return
        try:
            self.store.delete_project(self.project_id)
            self._fill_project()
            self._load_projects()
        except Exception as exc:
            self._error("Could not delete project", exc)

    def _load_routines(self):
        try:
            rows = self.store.list_routines()
        except Exception as exc:
            self._error("Could not load routines", exc)
            return
        self._routines = {row["id"]: row for row in rows}
        self.routine_list.blockSignals(True)
        self.routine_list.clear()
        for row in rows:
            item = QListWidgetItem(row["name"])
            item.setData(Qt.ItemDataRole.UserRole, row["id"])
            self.routine_list.addItem(item)
        self.routine_list.blockSignals(False)
        self._restore_selection(self.routine_list, self.routine_id)

    def _select_routine(self, current, _previous):
        if current is None:
            return
        target = current.data(Qt.ItemDataRole.UserRole)
        if target == self.routine_id:
            return
        if not self._confirm_unsaved("routine"):
            self._restore_selection(self.routine_list, self.routine_id)
            return
        row = self._routines.get(target)
        if row:
            self._fill_routine(row)

    def _fill_routine(self, row=None):
        self._loading = True
        self.routine_id = row["id"] if row else None
        self.routine_name.setText(row["name"] if row else "")
        self.step_table.setRowCount(0)
        for step in row["steps"] if row else []:
            self._insert_step(step["kind"], step["target"])
        self.routine_dirty = False
        self.routine_state.setText("Saved · " + str(row["updated_at"]) if row else "New routine · not saved yet")
        self._loading = False

    def new_routine(self):
        if not self._confirm_unsaved("routine"):
            return
        self._restore_selection(self.routine_list, None)
        self._fill_routine()
        self.routine_name.setFocus()

    def _insert_step(self, kind="app", target="notepad"):
        row = self.step_table.rowCount()
        self.step_table.insertRow(row)
        combo = QComboBox()
        combo.addItems(["app", "url", "folder"])
        combo.setCurrentText(kind)
        target_input = QLineEdit(target)
        target_input.setMaxLength(2048)
        target_input.setPlaceholderText("notepad, https://example.com, or C:\\Projects")
        combo.currentTextChanged.connect(self._routine_changed)
        target_input.textChanged.connect(self._routine_changed)
        self.step_table.setCellWidget(row, 0, combo)
        self.step_table.setCellWidget(row, 1, target_input)
        self.step_table.setRowHeight(row, 43)
        self.step_table.setCurrentCell(row, 0)

    def add_step(self):
        if self.step_table.rowCount() >= 20:
            self._error("Routine limit", "A routine can contain at most 20 steps.")
            return
        self._insert_step()
        self._routine_changed()

    def remove_step(self):
        row = self.step_table.currentRow()
        if row >= 0:
            self.step_table.removeRow(row)
            self._routine_changed()

    def _steps(self):
        return [
            {"kind": self.step_table.cellWidget(row, 0).currentText(), "target": self.step_table.cellWidget(row, 1).text()}
            for row in range(self.step_table.rowCount())
        ]

    def save_routine(self) -> bool:
        try:
            self.routine_id = self.store.save_routine(self.routine_name.text(), self._steps(), self.routine_id)
            self.routine_dirty = False
            self.routine_state.setText("Saved on this PC")
            self._load_routines()
            return True
        except Exception as exc:
            self._error("Could not save routine", exc)
            return False

    def delete_routine(self):
        if self.routine_id is None or self._worker:
            return
        if QMessageBox.question(self, "Delete routine", "Delete this saved routine?", QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No, QMessageBox.StandardButton.No) != QMessageBox.StandardButton.Yes:
            return
        try:
            self.store.delete_routine(self.routine_id)
            self._fill_routine()
            self._load_routines()
        except Exception as exc:
            self._error("Could not delete routine", exc)

    def run_selected_routine(self):
        if self._worker:
            return
        if self.routine_dirty or self.routine_id is None:
            if not self.save_routine():
                return
        worker = RoutineWorker(self.store, self.routine_id)
        self._worker = worker
        _WORKERS.add(worker)
        worker.completed.connect(self._run_completed)
        worker.failed.connect(self._run_failed)
        worker.finished.connect(lambda: self._run_finished(worker))
        self.run_button.setEnabled(False)
        self.save_routine_button.setEnabled(False)
        self.delete_routine_button.setEnabled(False)
        self.run_result.setText("Requesting routine launches…")
        worker.start()

    def _run_completed(self, result):
        rows = result.get("results", []) if isinstance(result, dict) else []
        lines = [f"{i}. {row.get('kind', 'step')} · {row.get('target', '')}: {row.get('status', 'unknown')}" + (f" — {row['detail']}" if row.get("detail") else "") for i, row in enumerate(rows, 1)]
        status = result.get("status", "unknown") if isinstance(result, dict) else "unknown"
        heading = "Launches requested. Check the opened windows to confirm." if status in ("requested", "done") else f"Routine status: {status}."
        self.run_result.setText(heading + ("\n" + "\n".join(lines) if lines else ""))
        self.refresh_activity(force=True)

    def _run_failed(self, error: str):
        self.run_result.setText("Routine could not run: " + error)
        self.refresh_activity(force=True)

    def _run_finished(self, worker):
        _WORKERS.discard(worker)
        self._worker = None
        self.run_button.setEnabled(True)
        self.save_routine_button.setEnabled(True)
        self.delete_routine_button.setEnabled(True)
        worker.deleteLater()

    def refresh_activity(self, force=False):
        try:
            rows = self.store.list_activity(limit=200)
            signature = repr(rows)
            if not force and signature == self._activity_signature:
                return
            self._activity_signature = signature
            self.activity_table.setRowCount(len(rows))
            for row_index, row in enumerate(rows):
                for col, key in enumerate(("created_at", "tool", "status", "detail")):
                    original = str(row.get(key, ""))
                    display = _local_timestamp(original) if key == "created_at" else original
                    item = QTableWidgetItem(display)
                    item.setToolTip(original)
                    self.activity_table.setItem(row_index, col, item)
            self.activity_table.resizeRowsToContents()
            self.activity_state.setText(f"{len(rows)} most recent entries · refreshes every 3 seconds")
        except Exception as exc:
            self.activity_state.setText("Activity unavailable: " + str(exc))

    def clear_activity(self):
        if QMessageBox.question(self, "Clear history", "Clear the local activity history? This does not undo any actions.", QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No, QMessageBox.StandardButton.No) != QMessageBox.StandardButton.Yes:
            return
        try:
            self.store.clear_activity()
            self.refresh_activity(force=True)
        except Exception as exc:
            self._error("Could not clear activity", exc)

    def reject(self):
        # Escape must honor the same unsaved-change and active-worker checks.
        self.close()

    def closeEvent(self, event):
        if self._worker and self._worker.isRunning():
            QMessageBox.information(self, "Routine in progress", "Wait for the current routine launch to finish before closing this workspace.")
            event.ignore()
            return
        if not self._confirm_unsaved("project") or not self._confirm_unsaved("routine"):
            event.ignore()
            return
        self._timer.stop()
        event.accept()


def open_workspace(parent=None) -> WorkspaceWindow:
    """Open or raise the workspace within an existing Qt application."""
    if QApplication.instance() is None:
        raise RuntimeError("Create a QApplication before opening the workspace.")
    for window in _WINDOWS[:]:
        try:
            visible = window.isVisible()
        except RuntimeError:
            # Qt can delete a native window before its destroyed callback runs.
            if window in _WINDOWS:
                _WINDOWS.remove(window)
            continue
        if visible:
            window.showNormal()
            window.raise_()
            window.activateWindow()
            return window
    window = WorkspaceWindow(parent)
    _WINDOWS.append(window)
    window.destroyed.connect(lambda: _WINDOWS.remove(window) if window in _WINDOWS else None)
    window.show()
    window.raise_()
    window.activateWindow()
    return window


def main() -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    open_workspace()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
