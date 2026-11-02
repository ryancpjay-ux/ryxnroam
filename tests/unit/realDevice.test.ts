/**
 * OPT-IN real-hardware check. Runs only with ROAM_REAL_IOS_UDID set, e.g.
 *   ROAM_REAL_IOS_UDID=<udid> npx vitest run tests/unit/realDevice.test.ts
 * It only sends "clear" (restore the real location), so it never moves the device.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/defaults";
import { IosDeviceAdapter } from "../../src/main/devices/iosDevice";
import { liveChildCount, loadShellPath } from "../../src/main/exec";

const udid = process.env.ROAM_REAL_IOS_UDID;

describe.skipIf(!udid)("real iOS device (clear only)", () => {
  it("connects through the helper, clears, and leaves no process behind", { timeout: 120_000 }, async () => {
    await loadShellPath();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const adapter = new IosDeviceAdapter();
    const signal = new AbortController().signal;
    expect((await adapter.probe(settings, signal)).available).toBe(true);
    const device = (await adapter.discover(settings, signal)).find((d) => d.nativeId === udid);
    expect(device, "device listed").toBeTruthy();
    expect(device!.state).toBe("connected");
    const session = adapter.openSession(device!, settings);
    const res = await session.clear();
    expect(res).toEqual({ ok: true, confirmation: "exit-ok" });
    await session.dispose();
    expect(liveChildCount()).toBe(0);
  });
});
