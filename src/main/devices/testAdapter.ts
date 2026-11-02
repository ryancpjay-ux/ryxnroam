import type { AdapterStatus, DeviceInfo, LatLng, SimError } from "../../shared/types";
import type { ApplyResult, DeviceAdapter, LocationSession } from "./adapter";

/**
 * Loopback test adapter. It changes no device's location; it exists so the
 * full simulation pipeline can be exercised (and automated tests can run)
 * without hardware. Everything it produces is labelled TEST in the UI.
 */
export interface TestBehaviour {
  latencyMs: number;
  failNext: SimError | null;
  disconnected: boolean;
  /** Expose a second loopback device (for exercising device switching). */
  secondDevice: boolean;
}

export const testBehaviour: TestBehaviour = { latencyMs: 120, failNext: null, disconnected: false, secondDevice: false };
export const testLog: { op: "apply" | "clear" | "play"; point?: LatLng; t: number }[] = [];

export class TestAdapter implements DeviceAdapter {
  readonly id = "test" as const;
  readonly label = "Loopback test adapter";

  platformSupported(): boolean {
    return true;
  }

  async probe(): Promise<AdapterStatus> {
    return {
      adapterId: this.id,
      label: this.label,
      platformSupported: true,
      available: true,
      detail: "Enabled in Settings › Devices. Changes no real device location.",
      checkedAt: Date.now(),
    };
  }

  async discover(): Promise<DeviceInfo[]> {
    if (testBehaviour.disconnected) return [];
    const devices: DeviceInfo[] = [
      {
        id: "test:loopback",
        adapterId: "test",
        nativeId: "loopback",
        name: "Loopback test device",
        model: "No hardware",
        osName: "Test",
        connection: "local",
        state: "connected",
        isTest: true,
        restoresOnStop: true,
        stateDetail: "Test adapter — no device location is changed.",
      },
    ];
    if (testBehaviour.secondDevice)
      devices.push({ ...devices[0], id: "test:loopback-2", nativeId: "loopback-2", name: "Loopback test device 2" });
    return devices;
  }

  openSession(): LocationSession {
    return new TestSession();
  }
}

class TestSession implements LocationSession {
  readonly capabilities = { continuous: true, minIntervalMs: 100, playback: false, restoresOnClear: true };
  onLost: ((e: SimError) => void) | null = null;

  private wait(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, testBehaviour.latencyMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    });
  }

  async apply(point: LatLng, signal: AbortSignal): Promise<ApplyResult> {
    await this.wait(signal);
    if (testBehaviour.disconnected)
      return { ok: false, error: { code: "device-disconnected", message: "Test device disconnected." } };
    if (testBehaviour.failNext) {
      const error = testBehaviour.failNext;
      testBehaviour.failNext = null;
      return { ok: false, error };
    }
    testLog.push({ op: "apply", point, t: Date.now() });
    return { ok: true, confirmation: "test" };
  }

  async clear(): Promise<ApplyResult> {
    await this.wait();
    testLog.push({ op: "clear", t: Date.now() });
    return { ok: true, confirmation: "test" };
  }

  async dispose(): Promise<void> {}
}
