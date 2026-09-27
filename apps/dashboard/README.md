# GovernCode Dashboard

The desktop app (v0). A thin client of `govd`: it does what the CLI does (projects, the
Controller, asks, Gates, Specs, the Trace), nothing more. Electron shell, React renderer, bundled with Vite.

## Screens

- **Terminal**: chat with the Controller of the selected project, or Home (no project:
  read and plan only). Text, tool steps and Spec progress stream in live. A **Gate**
  appears inline with the exact canonical request; **Allow once** or **Deny**.
- **Pipeline**: the Specs and their status. Select one for its details and **Diff**;
  **Accept** applies it to the project, **Discard** throws it away (both ask to confirm).
- **Checkpoints**: the selected project's Controller turns that changed files (id, time,
  files). **Undo** names exactly the files it will restore and asks to confirm; govd refuses,
  and the Dashboard shows why, if any of them changed since. The Terminal also shows a
  "Checkpoint T-n · k files · Undo" line after each such turn.
- **Gates**: every Gate waiting, from any project, answerable here too.
- **Trace**: the history, newest first, in local 24-hour time, with filter chips.

The top bar switches project, creates one (**New project**: name, location, git init),
adds an existing folder (**Open folder**), and chooses the project's **Controller**
(provider, model, effort). It shows govd's and the sandbox's status (from `hello`).
Everything updates live from govd's `watch` stream; against a govd without `watch`, the
screens fall back to a slow poll.
If govd is not running, the Dashboard says so, shows the command to start it, and keeps
retrying.

## Run it

From the repository root, with dependencies installed (`npm ci`):

```sh
node packages/gov/src/main.ts daemon start   # govd must be running
npm run build -w apps/dashboard               # typecheck + bundle into apps/dashboard/dist
npm start -w apps/dashboard                   # launch the built app
```

For development, `npm run dev -w apps/dashboard` serves the renderer from Vite with hot
reload and launches Electron against it (restart it after changing main or preload code).

`npm test -w apps/dashboard` checks the IPC contract, the socket client (against a scripted
govd and the real one), and the built preload. Build first so the preload test runs.

The Dashboard finds govd's socket the same way `gov` does: `GOVERNCODE_RUNTIME_DIR`, else
`$XDG_RUNTIME_DIR/governcode`, else the state directory.

## How it is put together

```
renderer (React, sandboxed)  ──window.governcode──  preload  ──IPC──  main process  ──Unix socket──  govd
```

- **Main** (`src/main`) owns the only connection to govd: one control connection for calls
  and the `watch` stream (reconnecting every 3 s while govd is down), and a fresh connection
  per `ask`, since govd ties an ask's Gates to the connection that asked. The native folder
  picker runs here too and hands the renderer only the chosen path. It accepts only the methods the
  screens use and validates their parameters with the protocol's own schemas before
  anything reaches govd. Only the app's own page may use the bridge.
- **Preload** (`src/preload`) exposes eight functions (`call`, `ask`, `status`, `retry`,
  `pickFolder`, `onEvent`, `onStatus`, `onWatch`) through `contextBridge`. Nothing else crosses.
- **Renderer** (`src/renderer`) has no Node, no sockets and no network:
  `contextIsolation` on, `nodeIntegration` off, `sandbox` on, and a Content Security Policy
  of `default-src 'self'`. Navigation, new windows, webviews and permission requests are all
  refused.
- **Shared** (`src/shared/contract.ts`) is the IPC contract: channel names, the method
  allowlist, and the types on both sides.

No telemetry. No remote content. Nothing is loaded from the network.

## Not yet

No packaged installers yet; run it from the repository.
