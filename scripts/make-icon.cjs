// Rasterizes build/icon.svg to build/icon.png (1024²) with Electron. Run: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, "../build/icon.svg"), "utf8");
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL(`data:text/html,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const sized = image.getSize().width === 1024 ? image : image.resize({ width: 1024, height: 1024, quality: "best" });
  fs.writeFileSync(path.join(__dirname, "../build/icon.png"), sized.toPNG());
  console.log("wrote build/icon.png", sized.getSize());
  app.quit();
});
