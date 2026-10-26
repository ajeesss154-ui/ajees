"""Install/restore a versioned add-on without reading JARVIS's API configuration."""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

VERSION = "1.0.0"
MAIN_IMPORT = "from personal_workspace.bridge import audit_tool as _workspace_audit_tool"
MAIN_DECORATOR = "    @_workspace_audit_tool\n"
UI_MARKER = "        # Personal Workspace integration v1\n"
UI_BLOCK = (UI_MARKER
            + "        try:\n"
            + "            from personal_workspace.bridge import install_button as _install_workspace_button\n"
            + "            _install_workspace_button(self._win)\n"
            + "        except Exception as _workspace_error:\n"
            + "            print('Personal Workspace could not open:', type(_workspace_error).__name__)\n")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(data)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _read_source(path):
    raw = path.read_bytes()
    return raw, raw.decode("utf-8-sig").replace("\r\n", "\n")


def source_patches(app):
    """Fail on unfamiliar source before making any file change."""
    patches = {}
    for name in ("main.py", "ui.py"):
        path = app / name
        _, source = _read_source(path)
        if name == "main.py":
            if MAIN_IMPORT not in source:
                anchor = "from core import outcome\n"
                if source.count(anchor) != 1:
                    raise ValueError("Unsupported main.py: expected import anchor was not found exactly once.")
                source = source.replace(anchor, anchor + MAIN_IMPORT + "\n", 1)
            anchor = "    async def _execute_tool(self, fc) -> types.FunctionResponse:\n"
            if source.count(anchor) != 1:
                raise ValueError("Unsupported main.py: the shared tool dispatcher has changed.")
            if MAIN_DECORATOR + anchor not in source:
                source = source.replace(anchor, MAIN_DECORATOR + anchor, 1)
        else:
            anchor = "        self.root = _RootShim(self._app)\n        self._win.show()\n"
            if source.count(anchor) != 1:
                raise ValueError("Unsupported ui.py: expected window startup was not found exactly once.")
            if UI_MARKER not in source:
                source = source.replace(anchor, anchor + UI_BLOCK, 1)
        ast.parse(source, filename=name)
        patches[name] = source.encode("utf-8")
    ignore_path = app / ".gitignore"
    ignore = ignore_path.read_text(encoding="utf-8") if ignore_path.exists() else ""
    for pattern in ("/personal_workspace/data/", "/personal_workspace/upgrade.json", "/upgrade-backups/"):
        if pattern not in ignore.splitlines():
            ignore = ignore.rstrip("\r\n") + "\n" + pattern + "\n"
    patches[".gitignore"] = ignore.encode("utf-8")
    return patches


def install(app, package_root=None):
    app = Path(app).resolve()
    package_root = Path(package_root or Path(__file__).resolve().parent)
    if not (app / "plugins").is_dir():
        raise ValueError("Choose the JARVIS installation folder containing main.py, ui.py, and plugins.")
    patches = source_patches(app)
    # Only explicit source files enter the update. API keys, config, memory, and
    # local databases are neither inspected nor copied into its source backup.
    required = ("__init__.py", "store.py", "bridge.py", "ui.py")
    sources = [(package_root / "personal_workspace" / name, "personal_workspace/" + name)
               for name in required]
    sources.append((package_root / "workspace_plugin.py", "plugins/personal_workspace.py"))
    if not all(src.is_file() for src, _ in sources):
        raise ValueError("Upgrade package is incomplete.")
    for src, rel in sources:
        data = src.read_bytes()
        ast.parse(data.decode("utf-8"), filename=rel)
        patches[rel] = data
    existing = app / "personal_workspace" / "upgrade.json"
    if existing.exists() and json.loads(existing.read_text(encoding="utf-8")).get("version") == VERSION:
        # Idempotent runs validate that installed code really matches this package.
        if all((app / rel).is_file() and (app / rel).read_bytes() == data for rel, data in patches.items()):
            return {"version": VERSION, "already_installed": True, "backup": None}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    backup = app / "upgrade-backups" / stamp
    backup.mkdir(parents=True)
    patches["personal_workspace/upgrade.json"] = json.dumps({"version": VERSION, "backup": str(backup)}).encode("utf-8")
    manifest = {"version": VERSION, "files": []}
    for rel, new_data in patches.items():
        path = app / rel
        existed = path.exists()
        row = {"path": rel, "existed": existed, "installed_sha256": digest(new_data)}
        if existed:
            dest = backup / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
            row["original_sha256"] = digest(path.read_bytes())
        manifest["files"].append(row)
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    changed = []
    try:
        for rel, data in patches.items():
            path = app / rel
            atomic_write(path, data)
            changed.append(rel)
    except Exception:
        for row in reversed(manifest["files"]):
            if row["path"] not in changed:
                continue
            target = app / row["path"]
            if row["existed"]:
                shutil.copy2(backup / row["path"], target)
            else:
                target.unlink(missing_ok=True)
        raise
    return {"version": VERSION, "backup": str(backup), "already_installed": False}


def restore(app, backup):
    app, backup = Path(app).resolve(), Path(backup).resolve()
    if backup.parent != app / "upgrade-backups":
        raise ValueError("Choose a backup created inside this JARVIS installation.")
    manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
    allowed = {"main.py", "ui.py", ".gitignore", "plugins/personal_workspace.py", "personal_workspace/upgrade.json"}
    before = {}
    for row in manifest["files"]:
        rel = row["path"]
        if rel not in allowed and not (rel.startswith("personal_workspace/") and rel.count("/") == 1 and rel.endswith(".py")):
            raise ValueError("Backup manifest contains an unexpected path.")
        target = app / rel
        if not target.is_file() or digest(target.read_bytes()) != row["installed_sha256"]:
            raise ValueError("A source file changed after this upgrade. Restore stopped to preserve your edits: " + rel)
        if row["existed"] and digest((backup / rel).read_bytes()) != row["original_sha256"]:
            raise ValueError("Backup source does not match its manifest.")
        before[rel] = target.read_bytes()
    changed = []
    try:
        for row in manifest["files"]:
            target = app / row["path"]
            if row["existed"]:
                atomic_write(target, (backup / row["path"]).read_bytes())
            else:
                target.unlink()
            changed.append(row["path"])
    except Exception:
        for rel in reversed(changed):
            (app / rel).write_bytes(before[rel])
        raise
    # Personal workspace notes/database remain intact for a later reinstall.


def discover_app():
    base = Path(os.environ.get("LOCALAPPDATA", ""))
    candidates = sorted(p for p in base.glob("PersonalJarvis*") if (p / "main.py").is_file() and (p / "ui.py").is_file())
    if not candidates:
        raise ValueError("JARVIS was not found. Run with --app followed by its installation folder.")
    if len(candidates) == 1:
        return candidates[0]
    print("Choose your JARVIS installation:")
    for i, path in enumerate(candidates, 1):
        print(f"  {i}. {path}")
    selection = int(input("Installation number: "))
    if not 1 <= selection <= len(candidates):
        raise ValueError("Invalid installation number.")
    return candidates[selection - 1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path)
    parser.add_argument("--restore", type=Path)
    args = parser.parse_args()
    try:
        app = args.app or discover_app()
        if args.restore:
            restore(app, args.restore)
            print("Previous source restored. Personal workspace records were kept.")
            return 0
        result = install(app)
        print("Personal Workspace " + VERSION + (" is already installed." if result["already_installed"] else " installed."))
        if result["backup"]:
            print("Source backup:", result["backup"])
        print("Restart JARVIS and click WORKSPACE in the top bar.")
        return 0
    except Exception as exc:
        print("Upgrade stopped:", str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
