import { app } from "electron";
import { EventEmitter } from "node:events";
import type { UpdateStatus } from "../shared/types";
import { logger } from "./log";

const log = logger("updates");
/** ryxnroam's own release repository (kept in sync with electron-builder.yml). */
export const RELEASE_REPO = { owner: "ryancpjay-ux", repo: "ryxnroam" } as const;
export const RELEASES_URL = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases`;

/**
 * GitHub Releases updates via electron-updater. Nothing downloads or installs
 * without an explicit click. Development builds report that updates are
 * unavailable instead of pretending to check.
 */
export class Updates extends EventEmitter {
  private status: UpdateStatus = { state: "idle" };
  private updater: typeof import("electron-updater").autoUpdater | null = null;

  /** @param beforeInstall stops any simulation and flushes data before the updater quits the app. */
  constructor(private readonly beforeInstall: () => Promise<void>) {
    super();
  }

  private set(s: UpdateStatus) {
    this.status = s;
    this.emit("status", s);
  }

  get(): UpdateStatus {
    return this.status;
  }

  private load() {
    if (this.updater) return this.updater;
    // Loaded lazily so startup never pays for it.
    const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
    // Explicit feed: works even for builds packaged without app-update.yml.
    autoUpdater.setFeedURL({ provider: "github", ...RELEASE_REPO, releaseType: "release" });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = null;
    autoUpdater.on("update-available", (i) =>
      this.set({ state: "available", version: i.version, notes: typeof i.releaseNotes === "string" ? i.releaseNotes : undefined }),
    );
    autoUpdater.on("update-not-available", (i) => this.set({ state: "up-to-date", version: i.version }));
    autoUpdater.on("download-progress", (p) => this.set({ state: "downloading", percent: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (i) => this.set({ state: "ready", version: i.version }));
    autoUpdater.on("error", (e) => {
      const msg = String(e?.message ?? e);
      log.warn(`Update error: ${msg}`);
      this.set({
        state: "error",
        message: /code sign|signature|not signed/i.test(msg)
          ? `This build is not code-signed, so it can't install updates itself. Download the latest version from ${RELEASES_URL}.`
          : /404|Unable to find latest version|No published versions/i.test(msg)
            ? `No published release was found at ${RELEASES_URL}.`
            : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(msg)
              ? "GitHub could not be reached. Check your internet connection."
              : msg.split("\n")[0].slice(0, 300),
      });
    });
    this.updater = autoUpdater;
    return autoUpdater;
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.set({ state: "unavailable", detail: "Update checks run in installed builds only (this is a development build)." });
      return this.status;
    }
    this.set({ state: "checking" });
    try {
      await this.load().checkForUpdates();
    } catch (e) {
      if (this.status.state === "checking") this.set({ state: "error", message: (e as Error).message.split("\n")[0] });
    }
    return this.status;
  }

  async download(): Promise<void> {
    if (this.status.state !== "available") return;
    this.set({ state: "downloading", percent: 0 });
    await this.load()
      .downloadUpdate()
      .catch(() => undefined);
  }

  async install(): Promise<void> {
    if (this.status.state !== "ready") return;
    await this.beforeInstall();
    this.load().quitAndInstall(false, true);
  }
}
