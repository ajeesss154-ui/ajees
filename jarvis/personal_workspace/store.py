"""Private workspace records and deliberately small, shell-free routines.

Importing this module does not touch disk or launch anything. Each Store method
uses its own SQLite connection, so the UI and assistant threads can share a Store.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import sqlite3
import subprocess
from urllib.parse import urlsplit
import webbrowser

APP_PRESETS = {
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
    "paint": "mspaint.exe",
    "explorer": "explorer.exe",
}
MAX_STEPS = 20


def _text(value, field, limit, *, blank=False):
    if not isinstance(value, str):
        raise ValueError(f"{field} must be text.")
    if "\x00" in value:
        raise ValueError(f"{field} contains an invalid character.")
    value = value.strip()
    if not value and not blank:
        raise ValueError(f"{field} is required.")
    if len(value) > limit:
        raise ValueError(f"{field} must be at most {limit} characters.")
    return value


def _id(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("ID must be a positive integer.")
    return value


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def validate_steps(steps):
    """Return normalized copies of a routine's steps; never execute input."""
    if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_STEPS:
        raise ValueError(f"A routine needs between 1 and {MAX_STEPS} steps.")
    clean = []
    for step in steps:
        if not isinstance(step, dict) or set(step) != {"kind", "target"}:
            raise ValueError("Each step needs exactly kind and target.")
        kind = _text(step["kind"], "Step kind", 20).lower()
        target = _text(step["target"], "Step target", 4096)
        if kind == "app":
            target = target.lower()
            if target not in APP_PRESETS:
                raise ValueError("App must be notepad, calculator, paint, or explorer.")
        elif kind == "url":
            try:
                parsed = urlsplit(target)
                port = parsed.port  # Also validate malformed or out-of-range ports.
            except ValueError as exc:
                raise ValueError("Enter a valid HTTP or HTTPS URL.") from exc
            if (parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname
                    or parsed.username is not None or parsed.password is not None
                    or any(c.isspace() or ord(c) < 32 for c in target)):
                raise ValueError("URLs must use HTTP or HTTPS and contain no credentials.")
        elif kind == "folder":
            if any(ord(c) < 32 for c in target):
                raise ValueError("Folder path contains an invalid character.")
        else:
            raise ValueError("Step kind must be app, url, or folder.")
        clean.append({"kind": kind, "target": target})
    return clean


class Store:
    def __init__(self, path=None):
        self.path = Path(path) if path is not None else Path(__file__).resolve().parent / "data" / "workspace.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS projects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
                    notes TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS routines (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    steps TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS activity (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
                    tool TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL
                );
            """)

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(str(self.path), timeout=15)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def list_projects(self, query=""):
        query = _text(query, "Search", 1000, blank=True).casefold()
        with self._connect() as conn:
            rows = [dict(row) for row in conn.execute("SELECT * FROM projects ORDER BY updated_at DESC, id DESC")]
        return [row for row in rows if not query or query in (row["title"] + "\n" + row["notes"]).casefold()]

    def save_project(self, title, notes, project_id=None):
        title = _text(title, "Project title", 120)
        notes = _text(notes, "Project notes", 50000, blank=True)
        with self._connect() as conn:
            if project_id is None:
                return conn.execute("INSERT INTO projects(title,notes,updated_at) VALUES(?,?,?)", (title, notes, _now())).lastrowid
            project_id = _id(project_id)
            cursor = conn.execute("UPDATE projects SET title=?,notes=?,updated_at=? WHERE id=?", (title, notes, _now(), project_id))
            if not cursor.rowcount:
                raise KeyError("Project not found.")
            return project_id

    def delete_project(self, project_id):
        with self._connect() as conn:
            if not conn.execute("DELETE FROM projects WHERE id=?", (_id(project_id),)).rowcount:
                raise KeyError("Project not found.")

    def list_routines(self):
        with self._connect() as conn:
            rows = [dict(row) for row in conn.execute("SELECT * FROM routines ORDER BY name COLLATE NOCASE, id")]
        for row in rows:
            row["steps"] = json.loads(row["steps"])
        return rows

    def save_routine(self, name, steps, routine_id=None):
        name = _text(name, "Routine name", 120)
        data = json.dumps(validate_steps(steps), ensure_ascii=False)
        try:
            with self._connect() as conn:
                if routine_id is None:
                    return conn.execute("INSERT INTO routines(name,steps,updated_at) VALUES(?,?,?)", (name, data, _now())).lastrowid
                routine_id = _id(routine_id)
                cursor = conn.execute("UPDATE routines SET name=?,steps=?,updated_at=? WHERE id=?", (name, data, _now(), routine_id))
                if not cursor.rowcount:
                    raise KeyError("Routine not found.")
                return routine_id
        except sqlite3.IntegrityError as exc:
            raise ValueError("A routine with that name already exists.") from exc

    def get_routine(self, identifier):
        if isinstance(identifier, int) and not isinstance(identifier, bool):
            clause, value = "id=?", _id(identifier)
        else:
            clause, value = "name=?", _text(identifier, "Routine name", 120)
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM routines WHERE " + clause, (value,)).fetchone()
        if row is None:
            raise KeyError("Routine not found.")
        result = dict(row)
        result["steps"] = json.loads(result["steps"])
        return result

    def delete_routine(self, routine_id):
        with self._connect() as conn:
            if not conn.execute("DELETE FROM routines WHERE id=?", (_id(routine_id),)).rowcount:
                raise KeyError("Routine not found.")

    def log_activity(self, tool, status, detail=""):
        tool = _text(tool, "Action name", 160)
        status = _text(status, "Status", 40)
        detail = _text(detail, "Action detail", 2000, blank=True)
        with self._connect() as conn:
            return conn.execute("INSERT INTO activity(created_at,tool,status,detail) VALUES(?,?,?,?)", (_now(), tool, status, detail)).lastrowid

    def finish_activity(self, activity_id, status, detail=""):
        status = _text(status, "Status", 40)
        detail = _text(detail, "Action detail", 2000, blank=True)
        with self._connect() as conn:
            if not conn.execute("UPDATE activity SET status=?,detail=? WHERE id=?", (status, detail, _id(activity_id))).rowcount:
                raise KeyError("Activity not found.")

    def list_activity(self, limit=200):
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000:
            raise ValueError("Activity limit must be between 1 and 1000.")
        with self._connect() as conn:
            return [dict(row) for row in conn.execute("SELECT * FROM activity ORDER BY id DESC LIMIT ?", (limit,))]

    def clear_activity(self):
        with self._connect() as conn:
            # Keep active actions so their eventual completion still has a row.
            conn.execute("DELETE FROM activity WHERE status <> 'running'")


def _execute_step(step):
    kind, target = step["kind"], step["target"]
    if kind == "url":
        if not webbrowser.open(target, new=2):
            raise RuntimeError("The browser did not accept the URL.")
    else:
        if platform.system() != "Windows":
            raise RuntimeError("App and folder routine steps require Windows.")
        if kind == "app":
            # Use the system directory rather than searching the current folder.
            system_dir = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
            subprocess.Popen([str(system_dir / APP_PRESETS[target])], shell=False)
        else:
            path = Path(os.path.expandvars(target)).expanduser()
            if not path.is_dir():
                raise FileNotFoundError("The routine folder does not exist.")
            # Only a verified directory reaches startfile, never an executable.
            os.startfile(str(path))


def run_routine(store, identifier):
    """Run explicit saved steps sequentially; stop at the first failed launch.

    A process launch or browser handoff cannot verify the application's final
    state. A successful run is therefore 'requested', never 'completed'.
    """
    routine = store.get_routine(identifier)
    steps = validate_steps(routine["steps"])
    activity_id = store.log_activity("routine:" + routine["name"], "running", f"Starting {len(steps)} saved steps.")
    results = []
    status = "requested"
    for index, step in enumerate(steps, 1):
        try:
            _execute_step(step)
            detail = "Launch requested; application state was not verified."
            step_status = "requested"
        except Exception as exc:
            detail = str(exc)[:1000] or "The step could not be launched."
            step_status = status = "failed"
        results.append({**step, "status": step_status, "detail": detail})
        # Deliberately omit targets and query strings from the activity log.
        store.log_activity("routine.step." + step["kind"], step_status, f"Step {index}: " + ("launch requested, not verified." if step_status == "requested" else "launch failed."))
        if step_status == "failed":
            break
    detail = (f"Launch requested for {len(results)} steps; results are not verified."
              if status == "requested" else f"Stopped at failed step {len(results)} of {len(steps)}; earlier steps may have launched.")
    store.finish_activity(activity_id, status, detail)
    return {"status": status, "routine_id": routine["id"], "name": routine["name"], "results": results, "detail": detail}
