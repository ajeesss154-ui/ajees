# JARVIS Personal Workspace 1.0

Adds a WORKSPACE button to FatihMakes/Mark-LVI (tested against source commit
4d4035c1b40a3bc796ac63f2f1b6a99bc0dd334d).

## Included

- Routines: save named sequences of supported app, website, and folder launches.
  App presets: Notepad, Calculator, Paint, and File Explorer. A launch request is
  not proof that the destination opened successfully; the workspace shows that.
- Project Memory: searchable, editable project notes; delete notes in the editor.
  This is separate from the original assistant's automatic conversation memory.
- Activity: records tool names, timestamps, elapsed time, and reported status from
  both Gemini and local engines, plus routine steps. Started/returned/unverified
  are distinct from confirmed. This release does not add universal undo or track
  actions performed outside JARVIS. Background actions retain their initial
  started status unless their own routine reports a final state.
- Voice/text tool: ask "Open my workspace", "List my routines", "Run my work
  routine", "Search my project notes for Alpha", or "Save these project notes".
  The AI connection is required for voice/text; the editor itself works offline.

## Install on Windows

1. Close the JARVIS application. Leave Desktop Commander open if using it.
2. Extract this package and double-click `Update JARVIS.cmd`.
3. Restart JARVIS with its existing desktop shortcut and click WORKSPACE at the top.

The updater uses Python 3.12 already installed during JARVIS setup. It finds
PersonalJarvis installations under LocalAppData; if there are several, choose
the correct folder in its prompt. No extra Python dependencies are needed.

Alternatively, from this package folder:

    py -3.12 install_upgrade.py --app "C:\path\to\PersonalJarvis"

The updater checks source compatibility before writing. Source backups are kept
under the installed app's `upgrade-backups` directory. It does not read, copy, or
rewrite config/api_keys.json or the original memory directory. An upgrade failure
rolls back source changes already made. Installing the same package twice does
not add duplicate hooks.

## Restore previous source

Close JARVIS. From the extracted package folder, run:

    py -3.12 install_upgrade.py --app "C:\path\to\PersonalJarvis" --restore "C:\path\to\PersonalJarvis\upgrade-backups\TIMESTAMP"

The restore refuses to overwrite source edits made after the upgrade. Workspace
notes and routines survive a restore and reinstall. Keep the source backup until
you have verified the update.

## Local records

Workspace data lives in `personal_workspace/data/workspace.sqlite3` inside the
installed app. It is not uploaded by this add-on. Notes explicitly retrieved by
the voice/text tool go to the AI provider selected in the original assistant.
The new activity log omits tool arguments and raw replies. The original app's
existing console logs are unchanged and may contain those values.

## Validation and limits

Persistence, concurrent updates, routine validation, partial failure, audit
status, cancellation, private-data preservation, source compatibility, repeated
installation, and restore behavior are covered by automated tests. Source syntax
was checked. Windows GUI rendering, real app launches, and live Gemini tool
selection still need verification on the user's Windows PC.

See ATTRIBUTION.md and LICENSE for the original source and license.
