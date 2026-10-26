# Personal JARVIS for Windows

A personal desktop assistant adapted from [FatihMakes/Mark-LVI](https://github.com/FatihMakes/Mark-LVI), with an added **Personal Workspace** for routines, editable project notes, and action history.

This is an independent personal-use adaptation, not an official FatihMakes release. Original source: commit `4d4035c1b40a3bc796ac63f2f1b6a99bc0dd334d`. See [attribution](ATTRIBUTION.md) and the original [CC BY-NC 4.0 license](LICENSE). Noncommercial use only under those terms.

## New workspace features

- **Routines:** save named sequences that open supported apps, websites, and folders. App presets are Notepad, Calculator, Paint, and File Explorer.
- **Project Memory:** create, search, edit, and delete project notes. Ask JARVIS to search or save notes through its workspace tool.
- **Activity:** view tool names, timestamps, elapsed time, and reported results. Launch requested, started, returned, failed, and confirmed are distinct states. The dashboard does not imply that every requested action succeeded.

Click **WORKSPACE** in the top bar after opening JARVIS. The editor works without an AI connection; voice and text commands require a configured provider.

## Upgrade an existing installation

1. Download [JARVIS Personal Workspace 1.0 ZIP](https://github.com/ajeesss154-ui/ajees/raw/refs/heads/main/jarvis/updates/JARVIS-Personal-Workspace-1.0.zip).
2. Close the JARVIS application, extract the ZIP, and open the extracted folder.
3. Double-click **Update JARVIS.cmd**.
4. Restart JARVIS with its existing shortcut and click **WORKSPACE**.

The updater checks compatibility, backs up changed source, and supports restoration. It does not read or rewrite your API-key configuration or existing conversation memory. If several installations are found, select the folder for your current assistant. See the [updater instructions](updates/workspace-1.0/README.md).

## Install a fresh copy on Windows

Use 64-bit **Python 3.12**. Download this repository through **Code → Download ZIP** and extract it, or clone it:

```powershell
git clone https://github.com/ajeesss154-ui/ajees.git
cd ajees/jarvis
py -3.12 -m venv .venv
& ".\.venv\Scripts\python.exe" setup.py
& ".\.venv\Scripts\python.exe" main.py
```

If using the ZIP, open PowerShell in the extracted folder and run the last three commands. Setup downloads dependencies and browser engines and can take several minutes. It must run from the repository folder.

On the first-run screen, select Windows and enter your own [Gemini API key](https://aistudio.google.com/app/apikey). Provider availability, free-tier eligibility, and quotas depend on your account and the selected model. The original assistant also has optional provider configuration; see its settings and [upstream documentation](docs/UPSTREAM.md).

The original assistant includes voice conversation, app and browser controls, reminders, document tools, and other integrations. Individual features can require permissions, extra tools, or separate account setup. Wake-word detection is optional and installed from settings.

## Try the workspace

1. In **Routines**, create a routine named `Work mode`, add an `app` step targeting `notepad`, and save it. Add a website or an existing folder if useful.
2. Click **Run routine**, or ask JARVIS: “Run my Work mode routine.” Check the opened windows to confirm the result.
3. In **Project Memory**, save your project goal, decisions, and next steps. Ask: “Search my project notes for [project name].” Use **Refresh projects** to see notes saved by a voice/text command.
4. In **Activity**, inspect the reported action status. Background tool entries can remain `started` when the original tool reports its later result outside the shared dispatcher. This release does not add universal undo.

## Data and credentials

- Enter credentials only in the local assistant. Do not upload `config/api_keys.json`, OAuth tokens, linked browser profiles, or private certificates.
- The original assistant stores its configuration locally, including API keys in plaintext. Voice, transcripts, and tool context may go to the provider selected in the original app.
- New workspace records are stored locally in `personal_workspace/data/workspace.sqlite3`. Notes retrieved for an AI answer are sent to that selected provider.
- The added activity log stores names, timings, and status, without tool arguments or raw replies. The original assistant's existing console logs are unchanged.

## Validation

The workspace's automated checks cover persistence, concurrent changes, input validation, partial routine failures, audit statuses, cancellation, source compatibility, private-data preservation, repeated installation, and restoration. Python source syntax and integration with the pinned source were checked.

Windows GUI rendering, real desktop launches, and live AI selection of the new tools remain unverified. The original assistant was launched by the user before this upgrade; the upgraded build still needs Windows verification.

Run the add-on checks without installing the GUI dependencies:

```powershell
py -3.12 -m unittest discover -s addon_tests -v
```

See [updater source](updates/workspace-1.0/) and [original documentation](docs/UPSTREAM.md) for further details.
