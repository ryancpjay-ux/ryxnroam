// Visual check: launches the built app with an isolated profile and saves screenshots.
// Usage: node tests/e2e/shot.mjs <out-dir>
import { _electron as electron } from "playwright";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const out = process.argv[2] ?? ".";
const profile = mkdtempSync(path.join(os.tmpdir(), "ryxnroam-shot-"));
const app = await electron.launch({ args: ["."], env: { ...process.env, ROAM_E2E: "1", ROAM_USER_DATA: profile } });
const win = await app.firstWindow();
const logs = [];
win.on("console", (m) => m.type() !== "log" && logs.push(`${m.type()}: ${m.text()}`));
win.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
const shot = (name) => win.screenshot({ path: path.join(out, `${name}.png`) });

await win.getByTestId("intro-enter").click();
await win.getByTestId("onboarding-skip").click();
await win.locator(".map-loading.done").waitFor({ timeout: 20000 });
await win.waitForTimeout(2500);
await shot("03-main");

// Enable the test adapter, pick a point, start a test simulation.
await win.evaluate(() => window.roam.settings.update({ devices: { showTestAdapter: true } }));
await win.getByTestId("device-trigger").getByText("Loopback test device").waitFor({ timeout: 10000 });
await win.evaluate(() => window.roam.settings.update({ location: { confirmBeforeStart: false } }));
const box = await win.getByTestId("map").boundingBox();
await win.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.4);
await win.waitForTimeout(1500);
await shot("04-selected");
await win.getByTestId("start-button").click();
await win.getByTestId("sim-banner").waitFor();
await win.waitForTimeout(1200);
await shot("05-simulating");
await win.getByTestId("banner-stop").click();
await win.waitForTimeout(800);

// Route mode with two stops and straight lines.
await win.getByTestId("mode-route").click();
await win.getByText("Follow roads").click();
await win.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.3);
await win.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.5);
await win.waitForTimeout(1200);
await shot("06-route");
await win.getByTestId("start-route").click();
await win.waitForTimeout(2500);
await shot("07-route-running");
await win.getByTestId("stop-route").click();

await win.evaluate(() => {});
await win.locator("button[aria-label='Open settings']").click();
await win.waitForTimeout(500);
await shot("08-settings");
await win.getByTestId("settings-tab-devices").click();
await win.waitForTimeout(400);
await shot("09-settings-devices");
await win.getByTestId("settings-done").click();
await win.evaluate(() => window.roam.settings.update({ general: { theme: "light" } }));
await win.waitForTimeout(2500);
await shot("10-light");
console.log(logs.join("\n") || "no console warnings/errors");
await app.close();
