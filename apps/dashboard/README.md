# GovernCode Dashboard

The desktop app (v0). A thin client of `govd`: it shows what the CLI shows and answers
Gates, nothing more. Electron shell, React renderer, bundled with Vite.

## Screens

- **Terminal**: chat with the Controller of the selected project, or Home (no project:
  read and plan only). Text, tool steps and Spec progress stream in live. A **Gate**
  appears inline with the exact canonical request; **Allow once** or **Deny**.
- **Pipeline**: the Specs and their status. Select one for its details and **Diff**;
  **Accept** applies it to the project, **Discard** throws it away (both ask to confirm).
- **Gates**: every Gate waiting, from any project, answerable here too.
- **Trace**: the history, newest first, in local 24-hour time, with filter chips.

The top bar switches project and shows govd's and the sandbox's status (from `hello`).
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
  (reconnecting every 3 s while govd is down) and a fresh connection per `ask`, since govd
  ties an ask's Gates to the connection that asked. It accepts only the methods the
  screens use and validates their parameters with the protocol's own schemas before
  anything reaches govd. Only the app's own page may use the bridge.
- **Preload** (`src/preload`) exposes six functions (`call`, `ask`, `status`, `retry`,
  `onEvent`, `onStatus`) through `contextBridge`. Nothing else crosses.
- **Renderer** (`src/renderer`) has no Node, no sockets and no network:
  `contextIsolation` on, `nodeIntegration` off, `sandbox` on, and a Content Security Policy
  of `default-src 'self'`. Navigation, new windows, webviews and permission requests are all
  refused.
- **Shared** (`src/shared/contract.ts`) is the IPC contract: channel names, the method
  allowlist, and the types on both sides.

No telemetry. No remote content. Nothing is loaded from the network.

## Not yet

Creating or opening projects and choosing the Controller stay in the CLI. Gates, Specs and
the Trace are polled every few seconds (govd has no watch stream yet). No packaged
installers yet; run it from the repository.
