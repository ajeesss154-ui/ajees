import asyncio
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from personal_workspace.bridge import audit_tool, _result_status
from personal_workspace.store import Store
# The standalone update keeps its installer beside this test directory. A full
# JARVIS checkout ships the same update under updates/workspace-1.0/ and keeps
# these tests under addon_tests/. Both layouts work without an external clone.
ROOT = Path(__file__).resolve().parents[1]
BUNDLED_UPDATE = ROOT / "updates" / "workspace-1.0"
PACKAGE = BUNDLED_UPDATE if (BUNDLED_UPDATE / "install_upgrade.py").is_file() else ROOT
_INSTALLER_SPEC = importlib.util.spec_from_file_location(
    "_workspace_upgrade_test_installer", PACKAGE / "install_upgrade.py"
)
INSTALLER = importlib.util.module_from_spec(_INSTALLER_SPEC)
_INSTALLER_SPEC.loader.exec_module(INSTALLER)
install, restore = INSTALLER.install, INSTALLER.restore

# Installer tests exercise anchor matching, byte-preserving backups, rollback,
# and private-data preservation using syntax-valid controlled source. They do
# not require the GUI, audio devices, provider keys, or another repository.
SOURCE_FIXTURES = {
    "main.py": """from __future__ import annotations
from core import outcome

class FixtureAssistant:
    async def _execute_tool(self, fc) -> types.FunctionResponse:
        return fc
""",
    "ui.py": """class JarvisUI:
    def __init__(self):
        self._app = None
        self._win = None
        self.root = _RootShim(self._app)
        self._win.show()
""",
}


class AuditTests(unittest.IsolatedAsyncioTestCase):
    def test_receipts(self):
        for text, expected in [
            ('status=done action=test', 'confirmed'),
            ('status=started action=test', 'started'),
            ('status=unverified action=test', 'unverified'),
            ('status=ask action=test', 'needs input'),
            ('status=failed action=test', 'failed'),
            ("Tool 'test' failed: cannot run", 'failed'),
            ('Done.', 'returned'),
            ('Text says status=done', 'returned'),
            ('[WORKSPACE_ERROR] disk trouble', 'failed'),
        ]:
            with self.subTest(text=text):
                self.assertEqual(_result_status(SimpleNamespace(response={'result':text})), expected)

    async def test_success_keeps_secrets_out_of_audit(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp)/'test.db')
            @audit_tool
            async def action(self, fc):
                return SimpleNamespace(response={'result':'status=done private=secret-result'})
            with patch('personal_workspace.bridge.Store',return_value=store):
                result = await action(None,SimpleNamespace(name='file_controller',args={'key':'secret-input'}))
            self.assertIn('secret-result', result.response['result'])
            rows = store.list_activity()
            self.assertEqual(rows[0]['status'],'confirmed')
            self.assertNotIn('secret', str(rows))

    async def test_cancellation_and_log_failure_do_not_change_execution(self):
        @audit_tool
        async def cancelled(self, fc):
            raise asyncio.CancelledError()
        @audit_tool
        async def okay(self, fc):
            return 42
        with patch('personal_workspace.bridge.Store',side_effect=OSError('disk full')):
            self.assertEqual(await okay(None,None),42)
            with self.assertRaises(asyncio.CancelledError):
                await cancelled(None,None)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = Path(self.tmp.name)/'app'
        self.app.mkdir()
        (self.app/'plugins').mkdir()
        (self.app/'config').mkdir()
        (self.app/'memory').mkdir()
        for name, source in SOURCE_FIXTURES.items():
            # Include Windows line endings to verify exact restoration, even
            # though the installed patched source normalizes them internally.
            (self.app/name).write_bytes(source.replace("\n", "\r\n").encode("utf-8"))
        self.original={name:(self.app/name).read_bytes() for name in ['main.py','ui.py']}
        (self.app/'config'/'api_keys.json').write_text('{"secret":"DO_NOT_TOUCH"}')
        (self.app/'memory'/'user.txt').write_text('User memory')

    def tearDown(self): self.tmp.cleanup()

    def test_install_idempotency_restore_and_preserve_private_data(self):
        result=install(self.app,PACKAGE)
        self.assertFalse(result['already_installed'])
        self.assertTrue(install(self.app,PACKAGE)['already_installed'])
        text=(self.app/'main.py').read_text()
        self.assertEqual(text.count('@_workspace_audit_tool'),1)
        self.assertEqual((self.app/'ui.py').read_text().count('# Personal Workspace integration v1'),1)
        store=Store(self.app/'personal_workspace'/'data'/'workspace.sqlite3')
        store.save_project('Retained','Notes survive uninstall')
        restore(self.app,result['backup'])
        self.assertEqual(self.original,{name:(self.app/name).read_bytes() for name in self.original})
        self.assertEqual(store.list_projects()[0]['title'],'Retained')
        self.assertEqual((self.app/'config'/'api_keys.json').read_text(),'{"secret":"DO_NOT_TOUCH"}')
        self.assertEqual((self.app/'memory'/'user.txt').read_text(),'User memory')
        self.assertFalse(any('api_keys' in str(p) for p in Path(result['backup']).rglob('*')))

    def test_unsupported_app_has_no_writes(self):
        (self.app/'main.py').write_text('print("changed version")')
        with self.assertRaises(ValueError): install(self.app,PACKAGE)
        self.assertFalse((self.app/'upgrade-backups').exists())

    def test_failure_rolls_source_back(self):
        import os
        original_replace=os.replace
        calls=[]
        def failing_replace(src,dst):
            calls.append(dst)
            if len(calls)==3: raise PermissionError('simulated file lock')
            return original_replace(src,dst)
        with patch.object(INSTALLER.os,'replace',side_effect=failing_replace):
            with self.assertRaises(PermissionError): install(self.app,PACKAGE)
        self.assertEqual(self.original,{name:(self.app/name).read_bytes() for name in self.original})

    def test_restore_preserves_source_edits(self):
        result=install(self.app,PACKAGE)
        with (self.app/'main.py').open('a') as out: out.write('\n# user change\n')
        with self.assertRaises(ValueError): restore(self.app,result['backup'])
        self.assertIn('# user change',(self.app/'main.py').read_text())

    def test_restore_failure_rolls_back_and_marker_survives_reinstall(self):
        result=install(self.app,PACKAGE)
        upgraded={name:(self.app/name).read_bytes() for name in self.original}
        real_write=INSTALLER.atomic_write
        calls=[]
        def fail_once(path,data):
            calls.append(path)
            if len(calls)==2: raise PermissionError('source locked')
            return real_write(path,data)
        with patch.object(INSTALLER,'atomic_write',side_effect=fail_once):
            with self.assertRaises(PermissionError): restore(self.app,result['backup'])
        self.assertEqual(upgraded,{name:(self.app/name).read_bytes() for name in self.original})
        marker=(self.app/'personal_workspace'/'upgrade.json').read_bytes()
        (self.app/'personal_workspace'/'bridge.py').write_text('# prior edited add-on')
        second=install(self.app,PACKAGE)
        restore(self.app,second['backup'])
        self.assertEqual((self.app/'personal_workspace'/'upgrade.json').read_bytes(),marker)


class PluginTests(unittest.TestCase):
    def test_search_read_save_use_same_store(self):
        spec=importlib.util.spec_from_file_location('addon_plugin',PACKAGE/'workspace_plugin.py')
        plugin=importlib.util.module_from_spec(spec);spec.loader.exec_module(plugin)
        with tempfile.TemporaryDirectory() as tmp:
            store=Store(Path(tmp)/'store.db')
            with patch('personal_workspace.store.Store',return_value=store):
                self.assertIn('status=done',plugin.run({'action':'save_project','title':'Alpha','notes':'Next milestone'}))
                self.assertIn('Alpha',plugin.run({'action':'search_projects','query':'milestone'}))
                self.assertIn('Next milestone',plugin.run({'action':'read_project','project_id':1}))
                self.assertIn('[WORKSPACE_ERROR]',plugin.run({'action':'read_project','project_id':True}))


if __name__=='__main__': unittest.main()
