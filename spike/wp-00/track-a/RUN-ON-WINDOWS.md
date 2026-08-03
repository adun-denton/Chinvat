# Track A — connection-mode measurement harness — Windows operator instructions

This is **disposable spike code**, written to answer one question: how do three
different ways of attaching browser automation compare (persistent profile,
extension relay, raw CDP)? Do not build production automation on top of it
without re-reading it first — it has no retry hardening, no config file, and
several best-effort/Windows-only workarounds called out in comments.

## Prerequisites

- Windows 11, Node.js 24 (`node -v` should print v24.x).
- From the `track-a` directory:
  ```
  npm i playwright
  npx playwright install chromium
  ```
  (This installs Playwright's own bundled Chromium build — not your system
  Chrome. The harness never touches your real Chrome profile; see the safety
  guard described below.)

## Two-terminal run sequence

**Terminal 1 — fixture server** (leave running for the whole session):
```
cd %USERPROFILE%\Documents\Chinvat\spike\wp-00\fixture
node server.mjs
```
You should see `fixture listening http://127.0.0.1:8177`.

**Terminal 2 — harness:**
```
cd %USERPROFILE%\Documents\Chinvat\spike\wp-00\track-a
node run-connection-modes.mjs
```
The harness checks the fixture URL is reachable before doing anything else.
If the fixture isn't running, it prints the exact command to start it and
exits — it never starts the fixture server itself.

### Optional flags
```
node run-connection-modes.mjs --modes=persistent-profile,extension,cdp --fixture=http://127.0.0.1:8177 --out=../results/track-a.json
```
- `--modes` — comma-separated subset of `persistent-profile`, `extension`, `cdp`.
- `--fixture` — base URL of the running fixture server.
- `--out` — where to write the results JSON. The default (`../results/track-a.json`)
  is resolved relative to the directory you run the command FROM, so run it
  from `track-a` as shown above unless you pass an absolute path.

## What to expect / how long it takes

Each of the 3 modes runs sequentially (not in parallel) and takes roughly
1–2 minutes, dominated by:
- a fixed 10-second scripted interaction window (event coverage),
- a 15-second **human takeover window** (see below),
- a full close + relaunch cycle for the session-persistence check,
- a second close + relaunch cycle after the simulated crash.

Total run time for all three modes: expect somewhere around **5–8 minutes**,
plus however long you spend during each takeover window. Several visible
Chrome windows will open and close during the run — this is expected.

## What you must do during the 15-second takeover window

For each mode, the terminal will print:
```
>>> TAKEOVER WINDOW (15s): please click around the visible fixture browser window now —
scroll the campaign grid, open the account switcher, or edit a budget value.
Do not close the browser window. <<<
```
When you see this: **click into the actual browser window** (it should already
be focused/visible) and manually scroll the campaign grid, click the account
switcher button, or start editing a campaign's daily budget. Then leave it
alone — after 15 seconds the harness automatically resumes control.

Afterward, open the results JSON and fill in `modes.<mode>.takeoverErgonomics.humanNotes`
by hand with what you actually did and whether anything looked broken,
laggy, or surprising. The automated `renderCountAdvanced` field is a weak
signal (see the code comment in `run-connection-modes.mjs` — the fixture's
render counter also ticks on its own via background timers), so your
handwritten notes are the actual ground truth for this metric.

## Where results land

`%USERPROFILE%\Documents\Chinvat\spike\wp-00\results\track-a.json` by default
(created if missing). The file is written even if one or more modes failed —
check `modes.<mode>.status` for `"ok"` vs `"failed"` and read `modes.<mode>.error`
for failures. Check the top-level `notes` array and each mode's `limitations`
array for anything the harness couldn't measure.

## What to send back

1. The full `results/track-a.json` file.
2. The console output from Terminal 2 (it prints a summary table at the end).
3. Your handwritten `humanNotes` for each mode's takeover window (fill these
   into the JSON before sending it back, or note them separately).
4. Anything you noticed that ISN'T in the JSON: window flicker, Windows
   security prompts (e.g. "Do you want to allow this app..."), antivirus
   interference, or anything that looked visually wrong in either the
   fixture page or the extension's behavior.

## Safety notes

- The harness refuses to launch against any profile directory whose path
  does not contain `chinvat-spike` — this is a hard-coded guard, checked
  right before every browser launch, specifically so a bug here can never
  point at your real Chrome profile. Profiles live under:
  `%LOCALAPPDATA%\chinvat-spike\profiles\wp00-*`
  You can delete that whole folder any time between runs to start clean.
- The `crashBehavior` measurement deliberately force-kills a Chrome process
  mid-run (via Task Manager-equivalent `taskkill /F`, or a direct child-process
  kill for the `cdp` mode). This is intentional. You may briefly see a Chrome
  window disappear without warning during that step — that's the test.

## If something fails

- **"fixture is not reachable"** — Terminal 1 isn't running, crashed, or is
  on a different port. Restart it and confirm `http://127.0.0.1:8177` loads
  in a normal browser tab first.
- **`npx playwright install chromium` fails / launch times out** — check
  corporate proxy/firewall settings; Playwright downloads a browser build
  from Microsoft's CDN on first install.
- **Extension mode: `extensionRelay.connected: false`** — the background
  service worker didn't connect within 10s. Possible causes: port `8898` is
  already in use by something else on your machine (check
  `netstat -ano | findstr 8898`), or the extension failed to load at all
  (Chrome will show a warning banner in the browser window if so — take a
  screenshot). The rest of that mode's metrics (observation, event coverage,
  etc.) are still collected via Playwright even if the relay never connects.
- **Windows shows a "Disable developer mode extensions" banner** — this is
  normal for unpacked/`--load-extension` extensions loaded outside the Web
  Store; it does not affect the measurement. Dismiss it if it's in the way.
- **crashBehavior shows `killError` instead of a real result** — the
  PowerShell-based process lookup (used for `persistent-profile` and
  `extension` modes, since Playwright doesn't expose the OS process handle
  for persistent contexts) couldn't find a matching `chrome.exe`. This can
  happen if `powershell.exe` is restricted by policy on your machine. It's
  recorded as a limitation, not a crash of the harness itself.
- **A leftover Chrome window is still open after the harness exits or you
  Ctrl+C'd it** — close it manually. The harness closes browser windows in
  its normal and error paths, but a hard Ctrl+C during a takeover window can
  still leave a window behind; this is a known gap in spike code, not a
  silent failure to report.
