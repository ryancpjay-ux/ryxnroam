// End-to-end tests: launch the built Electron app with an isolated profile and drive the UI.
// Device-level steps use the loopback TEST adapter — no real device location is changed.
// Run: npm run test:e2e   (needs network for map tiles, search and routing)
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { _electron as electron } from "playwright";

const profile = mkdtempSync(path.join(os.tmpdir(), "ryxnroam-e2e-"));
const readJson = (name) => JSON.parse(readFileSync(path.join(profile, `${name}.json`), "utf8")).data;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  // ROAM_APP_PATH points at a packaged executable to test the installed build instead of dist/.
  const exe = process.env.ROAM_APP_PATH;
  const app = await electron.launch({
    ...(exe ? { executablePath: exe, args: [] } : { args: ["."] }),
    env: { ...process.env, ROAM_E2E: "1", ROAM_USER_DATA: profile },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  win.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return { app, win, errors };
}

const testState = (app) => app.evaluate(() => ({ log: globalThis.__roamTest.testLog, children: globalThis.__roamTest.liveChildCount() }));
const setTest = (app, patch) => app.evaluate((_e, p) => Object.assign(globalThis.__roamTest.testBehaviour, p), patch);

describe("ryxnroam", () => {
  let app, win, errors;
  before(async () => {
    ({ app, win, errors } = await launch());
  });
  after(async () => {
    await app?.close().catch(() => {});
  });

  it("opens with the intro, then onboarding, and remembers completion", async () => {
    await win.getByTestId("intro").waitFor();
    await win.getByTestId("intro-enter").click();
    await win.getByTestId("onboarding-step-1").waitFor();
    for (let i = 2; i <= 5; i++) {
      await win.getByTestId("onboarding-next").click();
      await win.getByTestId(`onboarding-step-${i}`).waitFor();
    }
    await win.getByTestId("onboarding-finish").click();
    await win.getByTestId("onboarding-step-5").waitFor({ state: "detached" });
    await sleep(400);
    assert.ok(readJson("settings").onboarding.completedAt > 0);
  });

  it("loads the interactive map with real vector tiles", async () => {
    await win.locator(".map-loading.done").waitFor({ timeout: 30000 });
    await win.locator(".maplibregl-canvas").waitFor();
    const attribution = await win.locator(".maplibregl-ctrl-attrib").innerText();
    assert.match(attribution, /OpenStreetMap/);
  });

  it("reports no device when no tooling is installed, and explains why", async () => {
    await win.getByTestId("device-trigger").click();
    const menu = await win.getByTestId("device-menu").innerText();
    await win.keyboard.press("Escape");
    // On this machine simctl/adb/pymobiledevice3 may be absent; whatever is absent must be explained.
    const adapters = await win.evaluate(() => window.roam.devices.snapshot());
    for (const a of adapters.adapters.filter((x) => !x.available && x.platformSupported)) {
      const name = a.label.replace(/ \(.*\)$/, "");
      assert.ok(menu.includes(name), `${name} listed as not set up`);
    }
    assert.ok(!adapters.devices.some((d) => d.isTest), "test adapter hidden by default");
    assert.deepEqual(adapters.devices, [], "E2E runs never list real devices");
  });

  it("searches places and selects a result", async () => {
    await win.getByTestId("search-input").fill("Eiffel Tower Paris");
    const first = win.getByTestId("search-results").locator(".result").first();
    await first.waitFor({ timeout: 15000 });
    await first.click();
    const name = await win.getByTestId("selection-name").innerText();
    assert.ok(name.length > 0 && name !== "Finding address…");
    await win.waitForFunction(() => document.querySelector("[data-testid=lat-input]")?.value !== "");
    const lat = Number(await win.getByTestId("lat-input").inputValue());
    assert.ok(Math.abs(lat) <= 90 && lat !== 0);
  });

  it("accepts typed coordinates and shows preview-only status", async () => {
    await win.getByTestId("lat-input").fill("40.689247");
    await win.getByTestId("lng-input").fill("-74.044502");
    await win.getByTestId("lng-input").press("Enter");
    await sleep(300);
    assert.equal(await win.getByTestId("lat-input").inputValue(), "40.689247");
    assert.match(await win.getByTestId("location-foot").innerText(), /Preview only/);
    assert.equal(await win.getByTestId("start-button").isDisabled(), true, "start disabled without a device");
  });

  it("starts, confirms and stops a simulation on the test adapter", async () => {
    await win.evaluate(() => window.roam.settings.update({ devices: { showTestAdapter: true } }));
    await win.getByTestId("device-trigger").getByText("Loopback test device").waitFor({ timeout: 10000 });
    await win.getByTestId("start-button").click();
    await win.getByTestId("confirm-ok").click(); // confirm-before-start dialog
    await win.getByTestId("sim-banner").getByText("Test simulation on").waitFor();
    assert.match(await win.getByTestId("status-pill").innerText(), /Test simulation active/);
    let st = await testState(app);
    assert.deepEqual(st.log.at(-1).point, { lat: 40.689247, lng: -74.044502 });
    await win.getByTestId("banner-stop").click();
    await win.getByTestId("sim-banner").waitFor({ state: "detached" });
    st = await testState(app);
    assert.equal(st.log.at(-1).op, "clear");
  });

  it("shows failure, not success, when the device rejects the location", async () => {
    await win.evaluate(() => window.roam.settings.update({ location: { confirmBeforeStart: false } }));
    await setTest(app, { failNext: { code: "rejected", message: "Rejected by test device" } });
    await win.getByTestId("start-button").click();
    await win.getByTestId("sim-banner").getByText("Simulation failed").waitFor();
    assert.match(await win.getByTestId("status-pill").innerText(), /Simulation failed/);
    await win.getByTestId("sim-banner").getByText("Dismiss").click();
  });

  it("detects a disconnect during simulation", async () => {
    await win.getByTestId("start-button").click();
    await win.getByTestId("sim-banner").getByText("Test simulation on").waitFor();
    await setTest(app, { disconnected: true });
    await win.evaluate(() => window.roam.devices.refresh());
    await win.getByTestId("sim-banner").getByText(/disconnected during simulation/).waitFor({ timeout: 10000 });
    await setTest(app, { disconnected: false });
    await win.evaluate(() => window.roam.devices.refresh());
    await win.getByTestId("sim-banner").getByText("Dismiss").click();
  });

  it("saves a favourite that persists", async () => {
    await win.getByTestId("save-location").click();
    await win.getByTestId("favorite-name").fill("Liberty Island test");
    await win.getByTestId("favorite-save").click();
    await win.getByTestId("favorites-list").getByText("Liberty Island test").waitFor();
    await sleep(400);
    assert.equal(readJson("library").favorites[0].name, "Liberty Island test");
  });

  it("builds, runs, pauses and stops a route", async () => {
    await win.getByTestId("mode-route").click();
    await win.getByText("Follow roads").click(); // straight lines: deterministic, no routing server
    const box = await win.getByTestId("map").boundingBox();
    await win.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.3);
    await win.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.35);
    await win.getByTestId("stops").locator(".stop-row").nth(1).waitFor();
    await win.getByTestId("start-route").click();
    await win.getByTestId("pause-button").waitFor();
    await sleep(1500);
    await win.getByTestId("pause-button").click();
    await win.getByTestId("resume-button").waitFor();
    assert.match(await win.getByTestId("status-pill").innerText(), /Route paused/);
    await win.getByTestId("resume-button").click();
    await sleep(800);
    const applies = (await testState(app)).log.filter((l) => l.op === "apply").length;
    assert.ok(applies > 2, `route sent ${applies} positions`);
    await win.getByTestId("stop-route").click();
    await win.getByTestId("sim-banner").waitFor({ state: "detached" });
  });

  it("saves the route", async () => {
    await win.getByTestId("save-route").click();
    await win.getByTestId("route-name").fill("E2E loop");
    await win.getByTestId("route-save").click();
    await sleep(400);
    assert.equal(readJson("library").routes[0].name, "E2E loop");
  });

  it("creates and runs a schedule after explicit consent", async () => {
    const fav = (await win.evaluate(() => window.roam.library.get())).favorites[0];
    const res = await win.evaluate(
      (id) => window.roam.schedules.create({ target: { kind: "favorite", favoriteId: id }, deviceId: "test:loopback", startAt: Date.now() + 1500, durationMinutes: null, consent: true }),
      fav.id,
    );
    assert.equal(res.ok, true);
    await sleep(3000);
    const s = (await win.evaluate(() => window.roam.schedules.list()))[0];
    assert.equal(s.status, "completed", s.outcomeDetail);
    await win.getByTestId("banner-stop").click();
    await win.getByTestId("sim-banner").waitFor({ state: "detached" });
  });

  it("switches devices from Settings and remembers the choice", async () => {
    await setTest(app, { secondDevice: true });
    await win.evaluate(() => window.roam.devices.refresh());
    await win.locator("button[aria-label='Open settings']").click();
    await win.getByTestId("settings-tab-devices").click();
    await win.getByTestId("use-device").click();
    await win.getByTestId("settings-done").click();
    await win.getByTestId("device-trigger").getByText("Loopback test device 2").waitFor();
    // The sidebar picker marks the device in use and can switch back.
    await win.getByTestId("device-trigger").click();
    await win.getByTestId("device-option-loopback-2").locator("[aria-label='In use']").waitFor();
    await win.getByTestId("device-option-loopback").click();
    await win.getByTestId("device-trigger").getByText(/^Loopback test device$/).waitFor();
    // Choose device 2 again; the restart below must keep it.
    await win.getByTestId("device-trigger").click();
    await win.getByTestId("device-option-loopback-2").click();
  });

  it("persists settings across restarts and leaves no child processes", async () => {
    await win.locator("button[aria-label='Open settings']").click();
    await win.getByTestId("settings-tab-location").click();
    await win.getByRole("combobox", { name: "Distance units" }).click();
    await win.getByRole("option", { name: /Imperial/ }).click();
    await win.getByTestId("settings-done").click();
    // Start a simulation, then quit: closing must stop it.
    await win.getByTestId("mode-location").click();
    await win.getByTestId("lat-input").fill("10");
    await win.getByTestId("lng-input").fill("10");
    await win.getByTestId("lng-input").press("Enter");
    await win.getByTestId("start-button").click();
    await win.getByTestId("sim-banner").getByText("Test simulation on").waitFor();
    assert.equal((await testState(app)).children, 0);
    const proc = app.process();
    await app.close();
    assert.ok(proc.exitCode !== null || proc.signalCode !== null, "electron process exited");
    const history = readJson("history");
    assert.notEqual(history[0].outcome, "running", "quitting ended the simulation record");

    ({ app, win, errors } = await launch());
    await win.getByTestId("app").waitFor();
    if (await win.getByTestId("intro").isVisible()) await win.getByTestId("intro-enter").click();
    const settings = await win.evaluate(() => window.roam.settings.get());
    assert.equal(settings.location.units, "imperial");
    assert.equal(settings.devices.showTestAdapter, true);
    // Device 2 appears only after start-up, as a Wi-Fi device would; the remembered choice must still win.
    await win.getByTestId("device-trigger").getByText(/^Loopback test device$/).waitFor({ timeout: 10000 });
    await setTest(app, { secondDevice: true });
    await win.evaluate(() => window.roam.devices.refresh());
    await win.getByTestId("device-trigger").getByText("Loopback test device 2").waitFor({ timeout: 10000 });
    assert.equal((await win.evaluate(() => window.roam.library.get())).favorites.length, 1);
    assert.equal(await win.getByTestId("onboarding-step-1").count(), 0, "onboarding not repeated");
  });

  it("logged no renderer errors", () => {
    assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), []);
  });
});

process.on("exit", () => {
  if (existsSync(profile) && process.env.ROAM_KEEP_PROFILE) console.log(`profile kept at ${profile}`);
});
