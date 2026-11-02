// After packaging, remove the unpacked .app built for the *other* Mac architecture.
// The DMG/ZIP for it are kept; only the unpacked copy is removed so Spotlight
// doesn't list a second ryxnroam that runs through Rosetta.
import { rmSync } from "node:fs";

const foreign = process.arch === "arm64" ? "release/mac" : "release/mac-arm64";
rmSync(foreign, { recursive: true, force: true });
console.log(`removed unpacked ${foreign} (installers kept)`);
