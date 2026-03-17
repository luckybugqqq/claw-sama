/**
 * Tauri desktop app process management for Claw Sama.
 */
import type { ChildProcess } from "node:child_process";
import { spawn, execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

let tauriProcess: ChildProcess | null = null;

/** Platform sub-package mapping: `${process.platform}-${process.arch}` → package + binary/app name */
const PLATFORM_PACKAGES: Record<string, { pkg: string; bin: string; isAppBundle: boolean }> = {
  "win32-x64":    { pkg: "@luckybugqqq/claw-sama-win32-x64",   bin: "claw-sama.exe",    isAppBundle: false },
  "darwin-arm64": { pkg: "@luckybugqqq/claw-sama-darwin-arm64", bin: "Claw Sama.app",    isAppBundle: true },
  "darwin-x64":   { pkg: "@luckybugqqq/claw-sama-darwin-x64",   bin: "Claw Sama.app",    isAppBundle: true },
};

/** Try to resolve binary from the installed optional dependency package. */
function resolveFromOptionalDep(): { path: string; isAppBundle: boolean } | null {
  const key = `${process.platform}-${process.arch}`;
  const entry = PLATFORM_PACKAGES[key];
  if (!entry) return null;
  try {
    const pkgJson = require.resolve(`${entry.pkg}/package.json`);
    const binPath = path.join(path.dirname(pkgJson), entry.bin);
    if (existsSync(binPath)) return { path: binPath, isAppBundle: entry.isAppBundle };
  } catch {
    // Package not installed (wrong platform or dev environment)
  }
  return null;
}

function spawnBinary(resolved: { path: string; isAppBundle: boolean }, log: { info: (msg: string) => void; warn: (msg: string) => void }) {
  log.info(`Launching Claw Sama: ${resolved.path} (appBundle=${resolved.isAppBundle})`);

  if (resolved.isAppBundle && process.platform === "darwin") {
    // npm does not preserve execute permissions — restore before launching
    try { execSync(`chmod -R +x ${JSON.stringify(resolved.path + "/Contents/MacOS")}`, { timeout: 5000 }); } catch {}
    tauriProcess = spawn("open", ["-W", "-a", resolved.path], { stdio: "ignore" });
  } else {
    if (!resolved.isAppBundle && process.platform !== "win32") {
      try { execFileSync("chmod", ["+x", resolved.path]); } catch {}
    }
    tauriProcess = spawn(resolved.path, [], { cwd: path.dirname(resolved.path), stdio: "ignore" });
  }

  tauriProcess.on("error", (err) => {
    log.warn(`Claw Sama process error: ${err.message}`);
    tauriProcess = null;
  });
  tauriProcess.on("exit", (code) => {
    log.info(`Claw Sama process exited (code: ${code})`);
    tauriProcess = null;
  });
}

export function launchTauri(appDir: string, log: { info: (msg: string) => void; warn: (msg: string) => void }) {
  // 1. Try pre-built binary from npm optional dependency
  const fromDep = resolveFromOptionalDep();
  if (fromDep) {
    spawnBinary(fromDep, log);
    return;
  }

  // 2. Fallback: npx tauri dev (development)
  if (!existsSync(appDir)) {
    log.warn(`Claw Sama: no pre-built binary and app directory not found: ${appDir}`);
    return;
  }

  log.info(`No pre-built binary found. Starting dev mode: npx tauri dev (cwd: ${appDir})`);
  tauriProcess = spawn("npx", ["tauri", "dev"], {
    cwd: appDir,
    stdio: "inherit",
    shell: true,
  });
  tauriProcess.on("error", (err) => {
    log.warn(`Claw Sama dev error: ${err.message}`);
    tauriProcess = null;
  });
  tauriProcess.on("exit", (code) => {
    log.info(`Claw Sama dev exited (code: ${code})`);
    tauriProcess = null;
  });
}

export function stopTauri(log: { info: (msg: string) => void }) {
  if (tauriProcess) {
    log.info("Stopping Claw Sama...");
    const proc = tauriProcess;
    tauriProcess = null;

    if (process.platform === "darwin") {
      try {
        execSync('osascript -e \'quit app "Claw Sama"\'', { timeout: 5000 });
      } catch {
        proc?.kill("SIGTERM");
      }
    } else {
      proc?.kill("SIGTERM");
    }

    setTimeout(() => {
      try { if (proc && !proc.killed) proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, 3000);
  }
}
