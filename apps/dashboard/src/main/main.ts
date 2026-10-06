// The Dashboard's main process: a thin Electron shell. It owns the only connection to govd
// and answers the renderer through a handful of checked IPC channels. The renderer runs
// sandboxed with context isolation and no Node; it cannot open sockets or files.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Channel, type Outcome } from "../shared/contract.ts";
import { checkAsk, checkCall, checkConnect, GovdError, socketPath } from "./govd-client.ts";
import { GovdLink } from "./link.ts";

// scripts/dev.ts sets this. A packaged app ignores it, and it must be local: whatever page it
// names gets the bridge, including gate.answer.
const devUrl = devServer(process.env.GOVERNCODE_DASHBOARD_DEV_URL);
function devServer(raw: string | undefined): string | undefined {
  if (!raw || app.isPackaged) return undefined;
  const u = new URL(raw);
  if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new Error("dev URL must be a local http server");
  return raw;
}
const indexFile = join(app.getAppPath(), "dist/renderer/index.html");
const appUrl = devUrl ? new URL(devUrl).origin : pathToFileURL(indexFile).href;

const link = new GovdLink(socketPath());
let win: BrowserWindow | null = null;
let watchWin: BrowserWindow | null = null;   // the Watch window: the same page, its #watch view
/** Every window of the app: live updates go to each. */
const windows = () => [win, watchWin].filter((w): w is BrowserWindow => !!w && !w.isDestroyed());

/** Only our own page may use the bridge (not a navigated-away or embedded frame). */
function fromApp(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? "";
  if (e.senderFrame !== e.sender.mainFrame) return false;
  return devUrl ? url.startsWith(appUrl + "/") : url.split(/[?#]/)[0] === appUrl;
}

function outcome<T>(f: () => Promise<T>): Promise<Outcome<T>> {
  return f().then((value) => ({ ok: true as const, value }),
    (err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err),
      code: err instanceof GovdError ? err.code : undefined }));
}

function handle(channel: string, f: (...args: any[]) => Promise<unknown>): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error("refused: not the Dashboard page");
    return f(...args);
  });
}

handle(Channel.status, async () => link.status());
handle(Channel.retry, () => link.start());
// The native folder picker runs here, in main; the renderer gets back only the chosen path.
handle(Channel.pickFolder, async () => {
  const opts = { title: "Choose a folder", properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
handle(Channel.call, (method: unknown, params: unknown) => outcome(() => {
  const req = checkCall(method, params);
  return link.call(req.method, req.params);
}));
// Sign-in links govd sent during a Connect: the only links the Dashboard will open in the browser.
// ponytail: kept for the session; a handful of links at most.
const signInLinks = new Set<string>();
handle(Channel.connect, (streamId: unknown, tool: unknown) => outcome(() => {
  const req = checkConnect(streamId, tool);
  return link.connect(req.params, (event) => {
    const url = (event as { url?: unknown }).url;
    if (typeof url === "string" && /^https:\/\/[^\s]+$/.test(url) && url.length < 4096) signInLinks.add(url);
    win?.webContents.send(Channel.event, req.streamId, event);
  });
}));
handle(Channel.openSignIn, async (url: unknown) => {
  if (typeof url !== "string" || !signInLinks.has(url)) return false;
  await shell.openExternal(url);
  return true;
});
handle(Channel.openWatch, async () => {
  if (watchWin && !watchWin.isDestroyed()) { watchWin.show(); watchWin.focus(); return true; }
  watchWin = pageWindow({ width: 1180, height: 820, minWidth: 720, minHeight: 520, title: "GovernCode · Watch" }, "watch");
  watchWin.on("closed", () => { watchWin = null; });
  return true;
});
handle(Channel.ask, (askId: unknown, project: unknown, prompt: unknown, continuationOf?: unknown) => outcome(() => {
  const req = checkAsk(askId, project, prompt, continuationOf);
  return link.ask(req.params, (event) => win?.webContents.send(Channel.event, req.askId, event));
}));

/** A window showing the Dashboard page (with `hash`, one view of it), sandboxed like the main one. */
function pageWindow(size: { width: number; height: number; minWidth: number; minHeight: number; title: string }, hash?: string): BrowserWindow {
  const w = new BrowserWindow({
    ...size,
    // The window's colour before the page paints, matching the theme the system asks for.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1013" : "#f6f6f8",
    show: false,
    webPreferences: {
      preload: join(app.getAppPath(), "dist/main/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  w.once("ready-to-show", () => w.show());
  if (devUrl) void w.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
  else void w.loadFile(indexFile, hash ? { hash } : undefined);
  return w;
}

function createWindow(): void {
  win = pageWindow({ width: 1360, height: 860, minWidth: 960, minHeight: 600, title: "GovernCode" });
  // Watch is the Dashboard's companion: it closes with it, so it never outlives the window it sends you to.
  win.on("closed", () => { win = null; if (watchWin && !watchWin.isDestroyed()) watchWin.close(); });
}

app.enableSandbox();
app.setName("GovernCode Dashboard");

// Nothing leaves the window: no navigation or redirect, no new windows, no downloads, no
// permission ever granted. (No external links either: nothing needs them yet.)
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (e) => e.preventDefault());
  contents.on("will-redirect", (e) => e.preventDefault());
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (e) => e.preventDefault());
  link.onStatus((s) => { for (const w of windows()) w.webContents.send(Channel.statusChanged, s); });
  link.onWatch((ev) => { for (const w of windows()) w.webContents.send(Channel.watch, ev); });
  void link.start();
  createWindow();
  app.on("activate", () => { if (!win) createWindow(); });
});

app.on("window-all-closed", () => {
  link.stop();
  if (process.platform !== "darwin") app.quit();
});
