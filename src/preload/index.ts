import { contextBridge, ipcRenderer } from "electron";
import { CH, EV, type RoamApi } from "../shared/ipc";

const invoke = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);
const listen =
  <T>(ch: string) =>
  (cb: (v: T) => void) => {
    const fn = (_e: unknown, v: T) => cb(v);
    ipcRenderer.on(ch, fn);
    return () => {
      ipcRenderer.removeListener(ch, fn);
    };
  };

const api: RoamApi = {
  app: {
    info: invoke(CH.appInfo) as RoamApi["app"]["info"],
    window: (action) => ipcRenderer.send(CH.appWindow, action),
    openExternal: invoke(CH.appOpenExternal) as RoamApi["app"]["openExternal"],
    onWindowState: listen(EV.windowState),
    onCommand: listen(EV.command),
  },
  settings: {
    get: invoke(CH.settingsGet) as RoamApi["settings"]["get"],
    update: invoke(CH.settingsUpdate) as RoamApi["settings"]["update"],
    onChange: listen(EV.settings),
  },
  devices: {
    snapshot: invoke(CH.devicesSnapshot) as RoamApi["devices"]["snapshot"],
    refresh: invoke(CH.devicesRefresh) as RoamApi["devices"]["refresh"],
    runAction: invoke(CH.devicesAction) as RoamApi["devices"]["runAction"],
    onChange: listen(EV.devices),
  },
  simulation: {
    state: invoke(CH.simState) as RoamApi["simulation"]["state"],
    startLocation: invoke(CH.simStartLocation) as RoamApi["simulation"]["startLocation"],
    startRoute: invoke(CH.simStartRoute) as RoamApi["simulation"]["startRoute"],
    pause: invoke(CH.simPause) as RoamApi["simulation"]["pause"],
    resume: invoke(CH.simResume) as RoamApi["simulation"]["resume"],
    setSpeed: invoke(CH.simSetSpeed) as RoamApi["simulation"]["setSpeed"],
    stop: invoke(CH.simStop) as RoamApi["simulation"]["stop"],
    dismissError: invoke(CH.simDismiss) as RoamApi["simulation"]["dismissError"],
    onState: listen(EV.simulation),
  },
  geo: {
    search: invoke(CH.geoSearch) as RoamApi["geo"]["search"],
    reverse: invoke(CH.geoReverse) as RoamApi["geo"]["reverse"],
    route: invoke(CH.geoRoute) as RoamApi["geo"]["route"],
  },
  library: {
    get: invoke(CH.libGet) as RoamApi["library"]["get"],
    saveFavorite: invoke(CH.libSaveFavorite) as RoamApi["library"]["saveFavorite"],
    deleteFavorite: invoke(CH.libDeleteFavorite) as RoamApi["library"]["deleteFavorite"],
    touchFavorite: invoke(CH.libTouchFavorite) as RoamApi["library"]["touchFavorite"],
    saveRoute: invoke(CH.libSaveRoute) as RoamApi["library"]["saveRoute"],
    deleteRoute: invoke(CH.libDeleteRoute) as RoamApi["library"]["deleteRoute"],
    exportRouteGpx: invoke(CH.libExportRouteGpx) as RoamApi["library"]["exportRouteGpx"],
    onChange: listen(EV.library),
  },
  history: {
    list: invoke(CH.historyList) as RoamApi["history"]["list"],
    clear: invoke(CH.historyClear) as RoamApi["history"]["clear"],
    onChange: listen(EV.history),
  },
  schedules: {
    list: invoke(CH.schedList) as RoamApi["schedules"]["list"],
    create: invoke(CH.schedCreate) as RoamApi["schedules"]["create"],
    cancel: invoke(CH.schedCancel) as RoamApi["schedules"]["cancel"],
    remove: invoke(CH.schedRemove) as RoamApi["schedules"]["remove"],
    onChange: listen(EV.schedules),
  },
  data: {
    exportAll: invoke(CH.dataExport) as RoamApi["data"]["exportAll"],
    importAll: invoke(CH.dataImport) as RoamApi["data"]["importAll"],
  },
  updates: {
    status: invoke(CH.updStatus) as RoamApi["updates"]["status"],
    check: invoke(CH.updCheck) as RoamApi["updates"]["check"],
    download: invoke(CH.updDownload) as RoamApi["updates"]["download"],
    install: invoke(CH.updInstall) as RoamApi["updates"]["install"],
    onStatus: listen(EV.updates),
  },
  diagnostics: {
    logs: invoke(CH.diagLogs) as RoamApi["diagnostics"]["logs"],
    report: invoke(CH.diagReport) as RoamApi["diagnostics"]["report"],
    copy: invoke(CH.diagCopy) as RoamApi["diagnostics"]["copy"],
  },
};

contextBridge.exposeInMainWorld("roam", api);
contextBridge.exposeInMainWorld("roamPlatform", process.platform);
