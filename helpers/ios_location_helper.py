#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Ryan J.
#
# ryxnroam iOS 17+ location helper.
#
# A separate program (GPL-3.0-or-later, because it imports pymobiledevice3) that
# ryxnroam starts and talks to over stdin/stdout with one JSON object per line.
#
# Why it exists: `pymobiledevice3 developer dvt simulate-location set` holds the
# location by blocking its event loop in signal.sigwait(). With the default
# no-root userspace tunnel the TCP stack runs on that loop, so the tunnel goes
# silent and the device drops it (and the simulated location) after ~30 s while
# the process still looks alive. This helper keeps the loop running for as long
# as the location should hold, re-confirms it periodically, and reports a lost
# connection instead of hiding it.
#
# Protocol
#   argv:   --udid <UDID> [--mode auto|userspace|native|tunneld]
#   stdout: {"event":"ready","transport":"userspace","pmd3":"11.49.1"}
#           {"id":1,"ok":true}  |  {"id":1,"ok":false,"error":"..."}
#           {"event":"lost","error":"..."}           (then exit code 3)
#   stdin:  {"id":1,"cmd":"set","lat":40.0,"lng":-74.0}
#           {"id":2,"cmd":"clear"}
#           {"id":3,"cmd":"quit"}
#   EOF on stdin (ryxnroam exited) clears the location and exits.

import argparse
import asyncio
import json
import platform
import sys
import threading
import traceback

KEEPALIVE_S = 4.0
CALL_TIMEOUT_S = 15.0


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def describe(exc):
    text = f"{type(exc).__name__}: {exc}".strip()
    return text if text != f"{type(exc).__name__}:" else type(exc).__name__


async def open_tunnel(udid, mode):
    """Return (handle, rsd, transport). handle has aclose(); None for tunneld."""
    from pymobiledevice3.exceptions import UserspaceTunnelUnavailableError

    if mode == "tunneld":
        from pymobiledevice3.tunneld.api import get_tunneld_device_by_udid

        rsd = await get_tunneld_device_by_udid(udid)
        if rsd is None:
            raise RuntimeError("tunneld is not running or does not serve this device. Start it with: sudo pymobiledevice3 remote tunneld")
        return None, rsd, "tunneld"

    if mode in ("auto", "userspace"):
        from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel

        handle = UserspaceRsdTunnel(serial=udid, remotepairing_fallback=False)
        try:
            return handle, await handle.aopen(), "userspace"
        except UserspaceTunnelUnavailableError:
            if mode == "userspace":
                raise
            # iOS 17.0-17.3 has no CoreDeviceProxy; macOS can piggyback Apple's own tunnel.

    if platform.system() != "Darwin":
        raise RuntimeError("This device needs a tunnel the userspace path can't provide. Run tunneld as administrator and choose the tunneld connection in ryxnroam.")
    from pymobiledevice3.remote.native_tunnel import NativeRemotedTunnel

    handle = NativeRemotedTunnel(serial=udid)
    return handle, await handle.aopen(), "native"


def start_stdin_reader(queue):
    """Read stdin on a daemon thread so a pending readline never blocks interpreter exit."""
    loop = asyncio.get_running_loop()

    def pump():
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                emit({"event": "warning", "error": f"ignored malformed command: {line[:80]}"})
                continue
            loop.call_soon_threadsafe(queue.put_nowait, msg)
        loop.call_soon_threadsafe(queue.put_nowait, {"cmd": "eof"})

    threading.Thread(target=pump, name="stdin", daemon=True).start()


async def run(udid, mode):
    from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
    from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

    try:
        from importlib.metadata import version

        pmd3 = version("pymobiledevice3")
    except Exception:
        pmd3 = "unknown"

    handle, rsd, transport = await open_tunnel(udid, mode)
    current = None
    try:
        async with DvtProvider(rsd) as dvt, LocationSimulation(dvt) as loc:
            emit({"event": "ready", "transport": transport, "pmd3": pmd3})
            queue = asyncio.Queue()
            start_stdin_reader(queue)
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_S)
                except asyncio.TimeoutError:
                    if current is None:
                        continue
                    # Re-assert the location: keeps it fresh and proves the channel is alive.
                    try:
                        await asyncio.wait_for(loc.set(*current), CALL_TIMEOUT_S)
                    except Exception as e:
                        emit({"event": "lost", "error": describe(e)})
                        return 3
                    continue

                cmd = msg.get("cmd")
                mid = msg.get("id")
                if cmd == "eof":
                    if current is not None:
                        await asyncio.wait_for(loc.clear(), CALL_TIMEOUT_S)
                    return 0
                if cmd == "quit":
                    emit({"id": mid, "ok": True})
                    return 0
                try:
                    if cmd == "set":
                        lat, lng = float(msg["lat"]), float(msg["lng"])
                        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                            raise ValueError("coordinates out of range")
                        await asyncio.wait_for(loc.set(lat, lng), CALL_TIMEOUT_S)
                        current = (lat, lng)
                    elif cmd == "clear":
                        await asyncio.wait_for(loc.clear(), CALL_TIMEOUT_S)
                        current = None
                    else:
                        raise ValueError(f"unknown command {cmd!r}")
                    emit({"id": mid, "ok": True})
                except (ValueError, KeyError) as e:
                    emit({"id": mid, "ok": False, "error": describe(e)})
                except Exception as e:
                    emit({"id": mid, "ok": False, "error": describe(e)})
                    emit({"event": "lost", "error": describe(e)})
                    return 3
    finally:
        if handle is not None:
            try:
                await handle.aclose()
            except Exception:
                pass
        elif rsd is not None:
            try:
                await rsd.close()
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(description="ryxnroam iOS 17+ location helper")
    parser.add_argument("--udid", required=True)
    parser.add_argument("--mode", default="auto", choices=["auto", "userspace", "native", "tunneld"])
    args = parser.parse_args()
    try:
        import pymobiledevice3  # noqa: F401
    except ImportError:
        emit({"event": "fatal", "error": "pymobiledevice3 is not installed for this Python interpreter."})
        return 2
    try:
        return asyncio.run(run(args.udid, args.mode))
    except KeyboardInterrupt:
        return 130
    except Exception as e:
        emit({"event": "fatal", "error": describe(e), "trace": traceback.format_exc()[-1500:]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
