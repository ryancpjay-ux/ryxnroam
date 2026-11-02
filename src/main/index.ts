import { BrowserWindow, Menu, Notification, app, nativeTheme, net, powerSaveBlocker, screen, shell } from "electron";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { EV } from "../shared/ipc";
import type { HistoryEntry, Library, Schedule, Settings, SimulationState } from "../shared/types";
import { AndroidEmulatorAdapter } from "./devices/androidEmulator";
import { IosDeviceAdapter } from "./devices/iosDevice";
import { IosSimulatorAdapter } from "./devices/iosSimulator";
import { DeviceManager } from "./devices/manager";
import { TestAdapter, testBehaviour, testLog } from "./devices/testAdapter";
import { killAllChildren, liveChildCount, loadShellPath } from "./exec";
import { History } from "./history";
import { registerIpc } from "./ipc";
import { logger } from "./log";
import * as sanitize from "./sanitize";
import { Scheduler } from "./scheduler";
import { configureHttp } from "./services/http";
import { SimulationController } from "./simulation/controller";
import { JsonStore } from "./store";
import { Updates } from "./updates";

const log = logger("app");
const E2E = process.env.ROAM_E2E === "1";

if (process.env.ROAM_USER_DATA) app.setPath("userData", process.env.ROAM_USER_DATA);
app.setName("ryxnroam");

if (!E2E && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
let quitting = false;
let powerBlocker: number | null = null;

const dataDir = () => app.getPath("userData");

function bootstrap() {
  const settingsStore = new JsonStore<Settings>(dataDir(), "settings", 1, () => structuredClone(DEFAULT_SETTINGS), (r) =>
    sanitize.settings(r),
  );
  const libraryStore = new JsonStore<Library>(dataDir(), "library", 1, () => ({ favorites: [], routes: [] }), (r) =>
    sanitize.library(r),
  );
  const historyStore = new JsonStore<HistoryEntry[]>(dataDir(), "history", 1, () => [], (r) => sanitize.history(r));
  const scheduleStore = new JsonStore<Schedule[]>(dataDir(), "schedules", 1, () => [], (r) => sanitize.schedules(r));
  const windowStore = new JsonStore<{ x?: number; y?: number; width: number; height: number; maximized: boolean }>(
    dataDir(),
    "window",
    1,
    () => ({ width: 1360, height: 860, maximized: false }),
    (r) => {
      const o = sanitize.isObj(r) ? r : {};
      return {
        x: typeof o.x === "number" ? o.x : undefined,
        y: typeof o.y === "number" ? o.y : undefined,
        width: Math.max(980, sanitize.num(o.width, 1360)),
        height: Math.max(640, sanitize.num(o.height, 860)),
        maximized: sanitize.bool(o.maximized, false),
      };
    },
  );

  const getSettings = () => settingsStore.get();
  const history = new History(historyStore);
  const devices = new DeviceManager(
    [new IosSimulatorAdapter(), new IosDeviceAdapter(), new AndroidEmulatorAdapter(), new TestAdapter()],
    getSettings,
    // E2E runs only ever drive the loopback adapter, even if real devices are plugged in.
    E2E && process.env.ROAM_E2E_REAL_DEVICES !== "1" ? new Set(["test"]) : null,
  );
  const controller = new SimulationController({
    getDevice: (id) => devices.get(id),
    getAdapter: (id) => devices.adapterFor(id),
    getSettings,
    history,
  });
  devices.on("lost", (id: string) => controller.deviceLost(id));

  const notify = (title: string, body: string) => {
    if (!getSettings().general.notifications || !Notification.isSupported()) return;
    new Notification({ title, body, silent: false }).show();
  };

  const scheduler = new Scheduler({
    store: scheduleStore,
    controller,
    getLibrary: () => libraryStore.get(),
    getDevice: (id) => devices.get(id),
    getSettings,
    notify,
  });
  const updates = new Updates(async () => {
    // Run the normal quit cleanup now, then let the updater quit without being intercepted.
    quitting = true;
    await shutdown();
  });

  configureHttp(
    (url, init) => net.fetch(url, init),
    `ryxnroam/${app.getVersion()} (desktop; +https://github.com/ryancpjay-ux/ryxnroam)`,
  );

  const send = (channel: string, payload: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  devices.on("change", (s) => send(EV.devices, s));
  history.on("change", (h) => send(EV.history, h));
  scheduler.on("change", (s) => send(EV.schedules, s));
  updates.on("status", (s) => send(EV.updates, s));

  let lastPhase: SimulationState["phase"] = "idle";
  controller.on("state", (s: SimulationState) => {
    send(EV.simulation, s);
    devices.pin(s.phase === "idle" || s.phase === "failed" ? null : s.adapterId);
    const active = s.phase !== "idle" && s.phase !== "failed";
    if (active && getSettings().location.keepAwake && powerBlocker === null)
      powerBlocker = powerSaveBlocker.start("prevent-app-suspension");
    if ((!active || !getSettings().location.keepAwake) && powerBlocker !== null) {
      powerSaveBlocker.stop(powerBlocker);
      powerBlocker = null;
    }
    if (s.phase === "failed" && lastPhase !== "failed" && !win?.isFocused())
      notify("Simulation stopped", s.error?.message ?? "The simulation failed.");
    lastPhase = s.phase;
  });

  registerIpc({
    getWindow: () => win,
    settingsStore,
    libraryStore,
    history,
    devices,
    controller,
    scheduler,
    updates,
    onSettingsChanged: (prev, next) => {
      send(EV.settings, next);
      if (
        prev.devices.pymobiledevice3Path !== next.devices.pymobiledevice3Path ||
        prev.devices.adbPath !== next.devices.adbPath ||
        prev.devices.showTestAdapter !== next.devices.showTestAdapter ||
        prev.devices.iosTunnel !== next.devices.iosTunnel
      )
        devices.invalidateProbes();
      if (prev.general.launchAtStartup !== next.general.launchAtStartup && app.isPackaged)
        app.setLoginItemSettings({ openAtLogin: next.general.launchAtStartup });
      if (prev.general.theme !== next.general.theme) applyTheme(next);
    },
  });

  const applyTheme = (s: Settings) => {
    nativeTheme.themeSource = s.general.theme;
  };
  applyTheme(getSettings());

  if (E2E) Object.assign(globalThis, { __roamTest: { testBehaviour, testLog, controller, devices, liveChildCount } });

  return { settingsStore, libraryStore, historyStore, scheduleStore, windowStore, devices, controller, scheduler, getSettings };
}

type Ctx = ReturnType<typeof bootstrap>;
let ctx: Ctx;

function createWindow() {
  const saved = ctx.windowStore.get();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(saved.width, area.width);
  const height = Math.min(saved.height, area.height);
  const onScreen =
    saved.x !== undefined &&
    saved.y !== undefined &&
    screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return saved.x! >= b.x - 50 && saved.y! >= b.y - 50 && saved.x! < b.x + b.width - 100 && saved.y! < b.y + b.height - 100;
    });
  const mac = process.platform === "darwin";

  win = new BrowserWindow({
    width,
    height,
    x: onScreen ? saved.x : undefined,
    y: onScreen ? saved.y : undefined,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    // Transparent windows can't be resized on Windows, so only macOS gets the rounded glass shell.
    transparent: mac,
    backgroundColor: mac ? "#00000000" : "#000000",
    hasShadow: true,
    show: false,
    title: "ryxnroam",
    icon: path.join(__dirname, "../../build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });
  if (saved.maximized) win.maximize();

  const devUrl = process.env.ROAM_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, "../renderer/index.html"));

  win.once("ready-to-show", () => win?.show());
  win.webContents.on("will-navigate", (e, url) => {
    if (!devUrl || !url.startsWith(devUrl)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const sendWindowState = () =>
    win?.webContents.send(EV.windowState, { maximized: win.isMaximized(), focused: win.isFocused() });
  for (const ev of ["maximize", "unmaximize", "focus", "blur"] as const) win.on(ev as "focus", sendWindowState);
  const visibility = () => ctx.devices.setVisible(!!win && win.isVisible() && !win.isMinimized());
  for (const ev of ["show", "hide", "minimize", "restore"] as const) win.on(ev as "show", visibility);

  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    ctx.windowStore.set({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);
  win.on("closed", () => {
    win = null;
  });
}

function buildMenu() {
  const command = (cmd: string) => () => win?.webContents.send(EV.command, cmd);
  const dev = !app.isPackaged;
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: "ryxnroam",
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { label: "Settings…", accelerator: "CmdOrCtrl+,", click: command("open-settings") },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    { role: "editMenu" },
    {
      label: "Simulation",
      submenu: [{ label: "Stop Simulation", accelerator: "CmdOrCtrl+.", click: command("stop-simulation") }],
    },
    {
      label: "View",
      submenu: dev
        ? [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }]
        : [{ role: "togglefullscreen" }],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function shutdown() {
  log.info("Shutting down: stopping simulation and cleaning up");
  try {
    await ctx.controller.shutdown();
  } catch (e) {
    log.error(`Shutdown: ${(e as Error).message}`);
  }
  ctx.scheduler.dispose();
  ctx.devices.dispose();
  for (const s of [ctx.settingsStore, ctx.libraryStore, ctx.historyStore, ctx.scheduleStore, ctx.windowStore]) s.flushSync();
  killAllChildren();
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on("before-quit", (e) => {
  if (quitting || !ctx) return;
  e.preventDefault();
  quitting = true;
  void shutdown().finally(() => app.exit(0));
});

app.on("window-all-closed", () => {
  // Closing the window always ends the simulation — it must never keep running unseen.
  app.quit();
});

process.on("exit", () => killAllChildren());

app.whenReady().then(async () => {
  ctx = bootstrap();
  buildMenu();
  createWindow();
  await loadShellPath();
  ctx.devices.start();
  ctx.scheduler.start();
  if (app.isPackaged) {
    const want = ctx.getSettings().general.launchAtStartup;
    if (app.getLoginItemSettings().openAtLogin !== want) app.setLoginItemSettings({ openAtLogin: want });
  }
  app.on("activate", () => {
    if (!win) createWindow();
  });
});
