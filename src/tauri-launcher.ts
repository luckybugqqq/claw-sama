/**
 * Tauri desktop app process management for Claw Sama.
 */
import type { ChildProcess } from "node:child_process";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

let tauriProcess: ChildProcess | null = null;

/** Platform sub-package mapping: `${process.platform}-${process.arch}` → package + binary name */
const PLATFORM_PACKAGES: Record<string, { pkg: string; bin: string }> = {
  "win32-x64":    { pkg: "@luckybugqqq/claw-sama-win32-x64",   bin: "claw-sama.exe" },
  "darwin-arm64": { pkg: "@luckybugqqq/claw-sama-darwin-arm64", bin: "claw-sama" },
  "darwin-x64":   { pkg: "@luckybugqqq/claw-sama-darwin-x64",   bin: "claw-sama" },
};

/** Try to resolve binary from the installed optional dependency package. */
function resolveFromOptionalDep(): string | null {
  const key = `${process.platform}-${process.arch}`;
  const entry = PLATFORM_PACKAGES[key];
  if (!entry) return null;
  try {
    const pkgJson = require.resolve(`${entry.pkg}/package.json`);
    const binPath = path.join(path.dirname(pkgJson), entry.bin);
    if (existsSync(binPath)) return binPath;
  } catch {
    // Package not installed (wrong platform or dev environment)
  }
  return null;
}

function resolveBuiltBinary(appDir: string): string | null {
  // 1. Try installed optional dependency (production path via npm)
  const fromDep = resolveFromOptionalDep();
  if (fromDep) {
    if (process.platform !== "win32") {
      try { execFileSync("chmod", ["+x", fromDep]); } catch {}
    }
    return fromDep;
  }

  // 2. Fallback: local build directory (development)
  const releaseDir = path.join(appDir, "src-tauri", "target", "release");
  const macArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const candidates: string[] =
    process.platform === "win32" ? [
      path.join(releaseDir, "claw-sama.exe"),
    ] : process.platform === "darwin" ? [
      path.join(releaseDir, `claw-sama-${macArch}-apple-darwin`),
      path.join(releaseDir, "claw-sama"),
    ] : [
      path.join(releaseDir, "claw-sama"),
    ];
  for (const p of candidates) {
    if (existsSync(p)) {
      if (process.platform !== "win32") {
        try { execFileSync("chmod", ["+x", p]); } catch {}
      }
      return p;
    }
  }
  return null;
}

export function launchTauri(appDir: string, log: { info: (msg: string) => void; warn: (msg: string) => void }) {
  const binPath = resolveBuiltBinary(appDir);
  if (binPath) {
    log.info(`Launching Claw Sama: ${binPath}`);
    tauriProcess = spawn(binPath, [], { cwd: path.dirname(binPath), stdio: "ignore" });
    tauriProcess.on("error", (err) => {
      log.warn(`Claw Sama process error: ${err.message}`);
      tauriProcess = null;
    });
    tauriProcess.on("exit", (code) => {
      log.info(`Claw Sama process exited (code: ${code})`);
      tauriProcess = null;
    });
    return;
  }

  if (!existsSync(appDir)) {
    log.warn(`Claw Sama: no pre-built binary and app directory not found: ${appDir}`);
    return;
  }

  log.info(`No pre-built binary found. Starting dev mode: npx tauri dev (cwd: ${appDir})`);

  const needsInstall = !existsSync(path.join(appDir, "node_modules"));
  const doDevLaunch = () => {
    const devProc = spawn("npx", ["tauri", "dev"], {
      cwd: appDir,
      stdio: "inherit",
      shell: true,
    });
    tauriProcess = devProc;
    devProc.on("error", (err) => {
      log.warn(`Claw Sama dev error: ${err.message}`);
      tauriProcess = null;
    });
    devProc.on("exit", (code) => {
      log.info(`Claw Sama dev exited (code: ${code})`);
      tauriProcess = null;
    });
  };

  if (needsInstall) {
    log.info(`Installing frontend dependencies: npm install (cwd: ${appDir})`);
    const installProc = spawn("npm", ["install"], {
      cwd: appDir,
      stdio: "inherit",
      shell: true,
    });
    installProc.on("exit", (installCode) => {
      if (installCode !== 0) {
        log.warn(`Claw Sama npm install failed (code: ${installCode})`);
        return;
      }
      doDevLaunch();
    });
  } else {
    doDevLaunch();
  }
}

export function stopTauri(log: { info: (msg: string) => void }) {
  if (tauriProcess) {
    log.info("Stopping Claw Sama...");
    const proc = tauriProcess;
    tauriProcess = null;
    proc?.kill("SIGTERM");
    setTimeout(() => {
      try { if (proc && !proc.killed) proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, 3000);
  }
}
