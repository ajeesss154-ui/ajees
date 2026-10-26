import concurrent.futures
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from personal_workspace.store import Store, run_routine, validate_steps


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "workspace.sqlite3"
        self.store = Store(self.path)

    def test_persistence_and_project_edit_delete(self):
        ident = self.store.save_project("Résumé plan", "Milestone: finish research")
        reopened = Store(self.path)
        self.assertEqual(reopened.list_projects("RÉSUMÉ")[0]["id"], ident)
        self.assertEqual(reopened.list_projects("research")[0]["notes"], "Milestone: finish research")
        reopened.save_project("Plan revised", "New milestone", ident)
        self.assertEqual(self.store.list_projects()[0]["title"], "Plan revised")
        reopened.delete_project(ident)
        self.assertEqual(self.store.list_projects(), [])
        with self.assertRaises(KeyError): reopened.delete_project(ident)
        with self.assertRaises(KeyError): reopened.save_project("Missing", "", ident)

    def test_names_notes_and_ids_are_validated(self):
        for title in ("", "  ", "x" * 121, None):
            with self.subTest(title=title), self.assertRaises(ValueError):
                self.store.save_project(title, "notes")
        with self.assertRaises(ValueError): self.store.save_project("Title", "x" * 50001)
        with self.assertRaises(ValueError): self.store.delete_project(True)
        with self.assertRaises(ValueError): self.store.save_project("Bad\x00name", "")
        self.store.save_project("Quotes ' % _", "")
        self.assertEqual(len(self.store.list_projects("%")), 1)

    def test_routine_names_are_unique_and_edits_keep_id(self):
        first = self.store.save_routine("Work", [{"kind": "app", "target": "notepad"}])
        with self.assertRaises(ValueError): self.store.save_routine("work", [{"kind":"app", "target":"paint"}])
        self.assertEqual(self.store.get_routine("Work")["id"], first)
        self.store.save_routine("Focus", [{"kind":"url", "target":"https://example.com"}], first)
        self.assertEqual(self.store.get_routine(first)["name"], "Focus")
        self.assertIsInstance(self.store.list_routines()[0]["steps"], list)
        self.store.delete_routine(first)
        with self.assertRaises(KeyError): self.store.get_routine(first)

    def test_rejects_dangerous_or_malformed_steps(self):
        bad = [[], [{"kind":"shell", "target":"echo hi"}], [{"kind":"app", "target":"cmd.exe"}],
               [{"kind":"url", "target":"javascript:alert(1)"}], [{"kind":"url", "target":"file:///C:/Windows"}],
               [{"kind":"url", "target":"https://user:secret@example.com"}],
               [{"kind":"url", "target":"https://example.com:99999"}],
               [{"kind":"url", "target":"https://example.com/a\n"+"b"}],
               [{"kind":"folder", "target":"a\x00b"}], [{"kind":"app", "target":"notepad", "extra":1}],
               [{"kind":"app", "target":"notepad"}]*21]
        for steps in bad:
            with self.subTest(steps=steps), self.assertRaises(ValueError): validate_steps(steps)
        self.assertEqual(validate_steps([{"kind":"app", "target":"NOTEPAD"}])[0]["target"], "notepad")
        validate_steps([{"kind":"folder", "target":r"%USERPROFILE%\Documents"}])

    def test_parallel_writes_and_activity_updates(self):
        def write(i):
            ident = self.store.log_activity("test", "running", str(i))
            self.store.finish_activity(ident, "completed", str(i))
            self.store.save_project("Project " + str(i), "")
            return ident
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            ids = list(executor.map(write, range(40)))
        self.assertEqual(len(set(ids)), 40)
        rows = self.store.list_activity()
        self.assertEqual(len(rows), 40)
        self.assertTrue(all(r["status"] == "completed" for r in rows))
        self.assertEqual(len(self.store.list_projects()), 40)
        self.store.clear_activity()
        self.assertEqual(self.store.list_activity(), [])
        self.assertEqual(len(self.store.list_projects()), 40)

    def test_clear_keeps_in_flight_activity_and_ids_are_not_reused(self):
        done = self.store.log_activity("done", "completed")
        running = self.store.log_activity("active", "running")
        self.store.clear_activity()
        self.assertEqual([r["id"] for r in self.store.list_activity()], [running])
        self.store.finish_activity(running, "completed")
        self.store.clear_activity()
        self.assertGreater(self.store.log_activity("new", "running"), running)

    def test_shell_free_apps_report_requested(self):
        ident = self.store.save_routine("Work", [{"kind":"app", "target":"notepad"}])
        with patch("personal_workspace.store.platform.system", return_value="Windows"), patch("personal_workspace.store.subprocess.Popen") as launch:
            result = run_routine(self.store, ident)
        self.assertEqual(result["status"], "requested")
        launch.assert_called_once()
        args, kwargs = launch.call_args
        self.assertEqual(len(args[0]), 1)
        self.assertTrue(args[0][0].endswith("notepad.exe"))
        self.assertIs(kwargs["shell"], False)
        self.assertTrue(all(r["status"] == "requested" for r in self.store.list_activity()))

    def test_partial_failure_stops_remaining_steps(self):
        ident = self.store.save_routine("Partial", [
            {"kind":"url", "target":"https://example.com/?token=private"},
            {"kind":"url", "target":"https://example.net"},
            {"kind":"app", "target":"notepad"}])
        with patch("personal_workspace.store.webbrowser.open", side_effect=[True, False]) as browser, patch("personal_workspace.store.subprocess.Popen") as launch:
            result = run_routine(self.store, ident)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(result["results"][0]["status"], "requested")
        self.assertEqual(browser.call_count, 2)
        launch.assert_not_called()
        self.assertNotIn("private", str(self.store.list_activity()))
        routine_rows = [r for r in self.store.list_activity() if r["tool"].startswith("routine:")]
        self.assertEqual(routine_rows[0]["status"], "failed")

    def test_windows_guard_and_folder_verification(self):
        ident = self.store.save_routine("Folder", [{"kind":"folder", "target":self.temp.name}])
        with patch("personal_workspace.store.platform.system", return_value="Linux"):
            self.assertEqual(run_routine(self.store, ident)["status"], "failed")
        with patch("personal_workspace.store.platform.system", return_value="Windows"), patch("personal_workspace.store.os.startfile", create=True) as launch:
            self.assertEqual(run_routine(self.store, ident)["status"], "requested")
            launch.assert_called_once_with(self.temp.name)
        missing = self.store.save_routine("Missing", [{"kind":"folder", "target":self.temp.name + "/missing"}])
        with patch("personal_workspace.store.platform.system", return_value="Windows"), patch("personal_workspace.store.os.startfile", create=True) as launch:
            self.assertEqual(run_routine(self.store, missing)["status"], "failed")
            launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
