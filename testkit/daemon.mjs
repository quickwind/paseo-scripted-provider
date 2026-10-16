// Isolated temp workspace + Paseo daemon lifecycle. Cross-platform: no shell, every child process
// is `process.execPath <script> ...` (the Paseo CLI bin shebang uses `env -S`, unusable on Windows).
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import treeKill from "tree-kill";

export const TESTKIT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TESTKIT_DIR, "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const require = createRequire(import.meta.url);

export function cliEntry() {
  const pkgJson = require.resolve("@getpaseo/cli/package.json");
  const entry = path.join(path.dirname(pkgJson), "dist", "index.js");
  if (!fs.existsSync(entry)) throw new Error(`Paseo CLI entry not found at ${entry}; run "npm ci --prefix testkit"`);
  return entry;
}

/** Files of this repo that make up the installed plugin (no node_modules: the daemon compiles it). */
const PLUGIN_FILES = ["paseo-plugin.json", "index.server.ts", "index.client.tsx", "client", "server", "shared"];

export const BUILTIN_PROVIDERS = ["claude", "codex", "copilot", "opencode", "pi", "omp", "antigravity", "muse", "devin"];

// Variables that could point Paseo or the providers it probes at the developer's real configuration.
const DROP_ENV = new Set([
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "PI_CODING_AGENT_DIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "HOME", "USERPROFILE", "APPDATA",
  "LOCALAPPDATA", "SCRIPTED_PROVIDER_STATE", "NODE_OPTIONS",
]);

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function tail(file, lines = 60) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return `(no ${file})`;
  }
}

export class Workspace {
  constructor({ keep = false, realHome = false } = {}) {
    this.keep = keep;
    // realHome: keep the user's HOME/XDG dirs so real provider CLIs (opencode, devin, ...) find their own
    // configuration and login. Paseo's own home, port and plugin state stay isolated.
    this.realHome = realHome;
    // Canonical path: macOS tmpdir is behind /var -> /private/var and Windows runners report 8.3 names.
    this.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "scripted-")));
    this.paseoHome = path.join(this.root, "paseo-home");
    this.fakeHome = path.join(this.root, "home");
    this.state = path.join(this.root, "state");
    this.logs = path.join(this.root, "logs");
    this.work = path.join(this.root, "work");
    this.plugins = path.join(this.root, "plugins");
    for (const dir of [this.paseoHome, this.fakeHome, this.state, this.logs, this.work, this.plugins]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.recordFile = path.join(this.state, "received.jsonl");
    this.scriptFile = path.join(this.state, "scenarios.json");
  }

  /** Copies this repo's plugin into the workspace and returns its directory. */
  stagePlugin() {
    const dest = path.join(this.plugins, "paseo-scripted-provider");
    fs.mkdirSync(dest, { recursive: true });
    for (const name of PLUGIN_FILES) {
      const src = path.join(REPO_ROOT, name);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, name), { recursive: true });
    }
    return dest;
  }

  env() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      const upper = key.toUpperCase();
      if (upper.startsWith("PASEO_") || DROP_ENV.has(upper)) continue;
      env[key] = value;
    }
    const h = this.fakeHome;
    if (this.realHome) {
      for (const key of DROP_ENV) if (process.env[key] !== undefined && key !== "SCRIPTED_PROVIDER_STATE" && key !== "NODE_OPTIONS") env[key] = process.env[key];
    } else {
      Object.assign(env, {
        HOME: h,
        USERPROFILE: h,
        XDG_CONFIG_HOME: path.join(h, ".config"),
        XDG_DATA_HOME: path.join(h, ".local", "share"),
        XDG_STATE_HOME: path.join(h, ".local", "state"),
        XDG_CACHE_HOME: path.join(h, ".cache"),
      });
    }
    Object.assign(env, { PASEO_HOME: this.paseoHome, SCRIPTED_PROVIDER_STATE: this.state, NO_COLOR: "1" });
    if (process.platform === "win32" && !this.realHome) {
      env.APPDATA = path.join(h, "AppData", "Roaming");
      env.LOCALAPPDATA = path.join(h, "AppData", "Local");
      fs.mkdirSync(env.APPDATA, { recursive: true });
      fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
    }
    return env;
  }

  collect(outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const copy = (src, name) => {
      if (fs.existsSync(src)) fs.cpSync(src, path.join(outDir, name), { recursive: true });
    };
    copy(this.logs, "daemon-stdout");
    copy(path.join(this.paseoHome, "daemon.log"), "paseo-daemon.log");
    copy(path.join(this.paseoHome, "config.json"), "paseo-config.json");
    copy(this.state, "plugin-state");
  }

  cleanup() {
    if (this.keep) {
      console.log(`[testkit] keeping workspace ${this.root}`);
      return;
    }
    try {
      fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`[testkit] could not remove ${this.root}: ${error?.message ?? error}`);
    }
  }
}

export class Daemon {
  constructor(ws, { port, timeScale = 1, enableProviders = [], providerConfigs = {} }) {
    // providerConfigs: custom provider definitions (e.g. ACP providers) merged into agents.providers.
    this.providerConfigs = providerConfigs;
    this.ws = ws;
    this.port = port;
    this.host = `127.0.0.1:${port}`;
    this.timeScale = timeScale;
    this.enableProviders = enableProviders;
    this.child = null;
    this.logFile = null;
    this.starts = 0;
  }

  writeConfig() {
    const file = path.join(this.ws.paseoHome, "config.json");
    let config = {};
    if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.version = 1;
    config.daemon = {
      ...config.daemon,
      listen: this.host,
      mcp: { enabled: false },
      relay: { enabled: false },
      enableTerminalAgentHooks: false,
    };
    config.features = { ...config.features, dictation: { enabled: false }, voiceMode: { enabled: false } };
    config.agents = {
      ...config.agents,
      providers: {
        ...Object.fromEntries(BUILTIN_PROVIDERS.map((id) => [id, { enabled: this.enableProviders.includes(id) }])),
        ...this.providerConfigs,
      },
    };
    config.pluginsEnabled = true; // plugins stay disabled without this top-level flag
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  }

  cli(args, { timeoutMs = 60000, check = true } = {}) {
    const res = spawnSync(process.execPath, [cliEntry(), ...args, "--home", this.ws.paseoHome], {
      env: this.ws.env(),
      cwd: this.ws.work,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (check && (res.status !== 0 || res.error)) {
      throw new Error(`paseo ${args.join(" ")} failed (status ${res.status}${res.error ? `, ${res.error.message}` : ""}):\n${out}`);
    }
    return { status: res.status, out, stdout: res.stdout ?? "" };
  }

  async start(label = "daemon") {
    this.writeConfig();
    this.starts++;
    this.logFile = path.join(this.ws.logs, `${label}-${this.starts}.log`);
    const fd = fs.openSync(this.logFile, "a");
    this.child = spawn(process.execPath, [cliEntry(), "daemon", "run", "--home", this.ws.paseoHome], {
      env: this.ws.env(),
      cwd: this.ws.work,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    fs.closeSync(fd);
    const child = this.child;
    child.exitInfo = null;
    child.once("exit", (code, signal) => {
      child.exitInfo = { code, signal };
    });

    const deadline = Date.now() + 120000 * this.timeScale;
    while (Date.now() < deadline) {
      if (child.exitInfo) break;
      const log = fs.existsSync(this.logFile) ? fs.readFileSync(this.logFile, "utf8") : "";
      if (log.includes("Listening on") && (await canConnect(this.port))) return;
      await sleep(250);
    }
    const why = child.exitInfo ? `exited early (${JSON.stringify(child.exitInfo)})` : "did not become ready in time";
    throw new Error(`Paseo daemon ${why}.\n--- ${this.logFile} ---\n${tail(this.logFile)}\n--- daemon.log ---\n${tail(path.join(this.ws.paseoHome, "daemon.log"))}`);
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (!child.exitInfo) {
      const res = this.cli(["daemon", "stop", "--timeout", "20"], { timeoutMs: 40000, check: false });
      if (res.status !== 0) console.warn(`[testkit] "paseo daemon stop" exited with ${res.status}: ${res.out.trim()}`);
    }
    const deadline = Date.now() + 15000;
    while (!child.exitInfo && Date.now() < deadline) await sleep(200);
    if (!child.exitInfo) {
      await new Promise((resolve) => treeKill(child.pid, "SIGKILL", () => resolve()));
      const killDeadline = Date.now() + 10000;
      while (!child.exitInfo && Date.now() < killDeadline) await sleep(200);
    }
  }

  /** Synchronous last-resort kill (process "exit" handler). */
  killNow() {
    const child = this.child;
    if (!child || child.exitInfo) return;
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }

  async restart(label) {
    await this.stop();
    await this.start(label);
  }
}
