#!/usr/bin/env node
// starts the slack desktop app with a local debug port and injects src/inject.js
// into every slack window. keeps running so reloads and new windows get it too.

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SDD_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const INJECT = join(here, "src", "inject.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[stop-dont-do]", ...a);

function findSlack() {
  if (process.env.SLACK_PATH) return process.env.SLACK_PATH;
  if (process.platform === "darwin") return "/Applications/Slack.app/Contents/MacOS/Slack";
  if (process.platform === "win32") {
    try {
      const loc = execSync(
        'powershell -NoProfile -Command "(Get-AppxPackage com.tinyspeck.slackdesktop).InstallLocation"',
        { encoding: "utf8" },
      ).trim();
      if (loc && existsSync(join(loc, "app", "Slack.exe"))) return join(loc, "app", "Slack.exe");
    } catch {}
    const squirrel = join(process.env.LOCALAPPDATA || "", "slack", "slack.exe");
    if (existsSync(squirrel)) return squirrel;
  }
  for (const p of ["/usr/bin/slack", "/snap/bin/slack"]) if (existsSync(p)) return p;
  throw new Error("couldn't find slack. set SLACK_PATH to the slack executable.");
}

function slackRunning() {
  try {
    if (process.platform === "win32") return execSync("tasklist /FI \"IMAGENAME eq slack.exe\" /NH", { encoding: "utf8" }).toLowerCase().includes("slack.exe");
    execSync("pgrep -x Slack || pgrep -x slack", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function quitSlack() {
  try {
    if (process.platform === "win32") execSync("taskkill /IM slack.exe /F", { stdio: "ignore" });
    else if (process.platform === "darwin") execSync("osascript -e 'quit app \"Slack\"'", { stdio: "ignore" });
    else execSync("pkill -x slack", { stdio: "ignore" });
  } catch {}
}

async function debuggable() {
  try {
    return (await fetch(`${BASE}/json/version`)).ok;
  } catch {
    return false;
  }
}

async function ensureSlack() {
  if (await debuggable()) return log("slack is already running with injection enabled");
  if (slackRunning()) {
    log("restarting slack so it can be modded…");
    quitSlack();
    for (let i = 0; i < 40 && slackRunning(); i++) await sleep(250);
  }
  const exe = findSlack();
  log("starting", exe);
  spawn(exe, [`--remote-debugging-port=${PORT}`], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 120; i++) {
    if (await debuggable()) return;
    await sleep(500);
  }
  throw new Error("slack started but the debug port never came up");
}

// runs inside the dash trailer's youtube player: hides its buttons, title and
// captions, and asks for the best quality the player offers
const YT_TWEAK = `(() => {
  const style = document.createElement("style");
  style.textContent = [
    ".ytp-chrome-top", ".ytp-chrome-bottom", ".ytp-gradient-top", ".ytp-gradient-bottom", ".ytp-large-play-button",
    ".ytp-player-controls", ".ytp-pause-overlay", ".ytp-pause-overlay-container", ".ytp-caption-window-container",
    ".caption-window", ".ytp-cued-thumbnail-overlay", ".ytp-spinner", ".ytp-bezel", ".ytp-bezel-text-wrapper",
    ".ytp-doubletap-ui-legacy", ".ytp-watermark", ".ytp-youtube-button", ".ytp-title", ".ytp-ce-element",
    ".ytp-paid-content-overlay", ".ytp-impression-link", ".ytp-endscreen-content", ".ytp-show-cards-title",
    ".ytp-overflow-overlay", ".ytp-contextmenu", ".ytp-tooltip", ".branding-img",
    // youtube's newer player chrome
    "player-middle-controls", "[class*='player-controls']", "player-top-controls", "player-bottom-controls"
  ].join(",") + " { display: none !important; }";
  document.documentElement.appendChild(style);
  let tries = 0;
  const tune = () => {
    const p = document.getElementById("movie_player");
    try {
      p.unloadModule("captions");
      p.unloadModule("cc");
      p.setOption("captions", "track", {});
    } catch {}
    try {
      // 1080p at most; the page lowers it further when the video is behind glass or hidden
      const best = (p.getAvailableQualityLevels() || []).find((q) => ["hd1080", "hd720", "large"].includes(q));
      if (best) { p.setPlaybackQualityRange(best, best); p.setPlaybackQuality?.(best); }
    } catch {}
    // autoplay sometimes doesn't start on its own; nudge it (muted, so it's allowed)
    try {
      if (tries < 4 && p.getPlayerState() !== 1) { if (p.isMuted && !p.isMuted()) p.mute(); p.playVideo(); }
    } catch {}
    if (++tries < 20) setTimeout(tune, 1000);
  };
  tune();
})();`;

// run an expression inside another frame (the spotify player) and return its value
async function evalInFrame(match, expression) {
  const t = (await (await fetch(`${BASE}/json/list`)).json()).find((t) => t.type === "iframe" && t.url.includes(match));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("websocket failed"));
  });
  const value = await new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) resolve(m.result?.result?.value ?? null);
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  ws.close();
  return value;
}

// the page can't reach into spotify's player itself, so it asks us (window.sddBridge)
const SPOTIFY_ACTIONS = {
  next: `document.querySelector('[data-testid="skip-forward"]')?.click(), true`,
  prev: `document.querySelector('button[aria-label="Previous"]')?.click(), true`,
  track: `(() => {
    const row = [...document.querySelectorAll('[data-testid^="tracklist-row-"]')].find((r) => {
      const b = r.querySelector('[data-testid="playback-indicator"]');
      return b && !/^play/i.test(b.getAttribute("aria-label") || "");
    });
    const parts = row ? [...row.querySelectorAll("h3, h4, p, span, a")].map((e) => e.textContent.trim()).filter(Boolean) : [];
    return { playlist: document.querySelector('[data-testid="entity-title"]')?.textContent.trim() || "", title: parts[0] || "", artist: parts[1] || "" };
  })()`,
};
// the spotify desktop app, through windows' media controls (media.ps1). started the
// first time dash asks, then kept open; one command in, one line of json out.
let mediaHelper = null;
const mediaQueue = [];
function mediaCommand(line) {
  if (process.platform !== "win32") return Promise.resolve({ ok: false, reason: "only on windows" });
  if (!mediaHelper) {
    mediaHelper = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "media.ps1")], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let buf = "";
    mediaHelper.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const out = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!out) continue;
        let v = null;
        try {
          v = JSON.parse(out);
        } catch {}
        mediaQueue.shift()?.(v);
      }
    });
    mediaHelper.on("exit", () => {
      mediaHelper = null;
      while (mediaQueue.length) mediaQueue.shift()(null);
    });
  }
  return new Promise((resolve) => {
    mediaQueue.push(resolve);
    mediaHelper.stdin.write(line + "\n");
  });
}

async function handleBridge(payload, send) {
  let msg;
  try {
    msg = JSON.parse(payload);
  } catch {
    return;
  }
  const reply = (result) => send("Runtime.evaluate", { expression: `window.__sddBridgeReply?.(${JSON.stringify({ id: msg.id, result })})` }).catch(() => {});
  if (msg.cmd === "jump" && typeof msg.name === "string") {
    // open a channel through slack's quick switcher: ctrl+k, its name, enter. slack only
    // takes real key presses for this, which the page itself can't make.
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const key = async (k, code, vk, modifiers = 0) => {
      for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    };
    await key("k", "KeyK", 75, 2);
    await wait(600);
    await send("Input.insertText", { text: msg.name });
    await wait(900);
    await key("Enter", "Enter", 13);
    return reply(true);
  }
  if (msg.cmd === "app") {
    if (msg.action === "open") {
      // open a playlist/album/song in the spotify app, e.g. spotify:playlist:<id>
      if (/^spotify:[a-z]+:[A-Za-z0-9]+$/.test(msg.uri || "")) spawn("cmd", ["/c", "start", "", msg.uri], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return reply(true);
    }
    const line = { state: "state", toggle: "toggle", next: "next", prev: "prev", seek: `seek ${Number(msg.arg) || 0}` }[msg.action];
    return reply(line ? await mediaCommand(line) : null);
  }
  const expr = msg.cmd === "spotify" && SPOTIFY_ACTIONS[msg.action];
  if (!expr) return;
  return reply(await evalInFrame("open.spotify.com/embed", expr).catch(() => null));
}

// one websocket per slack page; registers the script for future loads and runs it now
async function attach(target, { source = readFileSync(INJECT, "utf8"), persist = true } = {}) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.bindingCalled" && msg.params?.name === "sddBridge") return handleBridge(msg.params.payload, send);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("websocket failed"));
  });
  if (persist) {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Runtime.addBinding", { name: "sddBridge" });
    await send("Page.addScriptToEvaluateOnNewDocument", { source });
  }
  const res = await send("Runtime.evaluate", { expression: source });
  if (res.exceptionDetails) log("inject error:", res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return ws;
}

async function main() {
  await ensureSlack();
  const attached = new Map();
  let misses = 0;
  log("watching slack windows (leave this running)");
  for (;;) {
    let targets = [];
    try {
      targets = await (await fetch(`${BASE}/json/list`)).json();
      misses = 0;
    } catch {
      // slack can be briefly unreachable (switching workspaces, reloading); only give up
      // once it's been gone for a while
      if (++misses * 700 > 30000) {
        log("slack closed, bye");
        process.exit(0);
      }
      await sleep(700);
      continue;
    }
    for (const t of targets) {
      if (attached.has(t.id)) continue;
      // the dash trailer: tidy the player once, then let go
      if (t.type === "iframe" && t.url.includes("youtube-nocookie.com/embed/")) {
        attached.set(t.id, null);
        attach(t, { source: YT_TWEAK, persist: false })
          .then((ws) => ws.close())
          .catch(() => attached.delete(t.id));
        continue;
      }
      if (t.type !== "page" || !t.url.startsWith("https://app.slack.com/")) continue;
      attached.set(t.id, null);
      attach(t)
        .then((ws) => {
          attached.set(t.id, ws);
          ws.onclose = () => attached.delete(t.id);
          log("modded", t.url.replace(/\?.*/, ""));
        })
        .catch((e) => {
          attached.delete(t.id);
          log("couldn't attach:", e.message);
        });
    }
    await sleep(700);
  }
}

main().catch((e) => {
  log(e.message);
  process.exit(1);
});
