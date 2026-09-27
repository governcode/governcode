// The Dashboard's main process: a thin Electron shell. It owns the only connection to govd
// and answers the renderer through a handful of checked IPC channels. The renderer runs
// sandboxed with context isolation and no Node; it cannot open sockets or files.
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Channel, type Outcome } from "../shared/contract.ts";
import { checkAsk, checkCall, GovdError, socketPath } from "./govd-client.ts";
import { GovdLink } from "./link.ts";

const devUrl = process.env.GOVERNCODE_DASHBOARD_DEV_URL; // set only by scripts/dev.ts
const indexFile = join(app.getAppPath(), "dist/renderer/index.html");
const appUrl = devUrl ? new URL(devUrl).origin : pathToFileURL(indexFile).href;

const link = new GovdLink(socketPath());
let win: BrowserWindow | null = null;

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
handle(Channel.ask, (askId: unknown, project: unknown, prompt: unknown) => outcome(() => {
  const req = checkAsk(askId, project, prompt);
  return link.ask(req.params, (event) => win?.webContents.send(Channel.event, req.askId, event));
}));

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 560,
    title: "GovernCode Dashboard",
    backgroundColor: "#0b0f14",
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
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => { win = null; });
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(indexFile);
}

app.enableSandbox();
app.setName("GovernCode Dashboard");

// Nothing leaves the window: no navigation, no new windows (links open in the browser only
// if they are https), no permission ever granted.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (e) => e.preventDefault());
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  link.onStatus((s) => win?.webContents.send(Channel.statusChanged, s));
  link.onWatch((w) => win?.webContents.send(Channel.watch, w));
  void link.start();
  createWindow();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on("window-all-closed", () => {
  link.stop();
  if (process.platform !== "darwin") app.quit();
});
