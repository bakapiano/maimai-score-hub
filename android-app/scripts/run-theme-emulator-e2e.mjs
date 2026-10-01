import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Real frontend + native WebView, with offline data and loopback-only requests.
// Build deviceTest with -PmshDeviceTestWebUrl=http://localhost:19310/app/settings.
const exec = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [serial, output = resolve(project, "app/build/theme-emulator-e2e")] = process.argv.slice(2);
const adbPath = process.env.ADB_PATH || "D:/Android/Sdk/platform-tools/adb.exe";
const apk = process.env.THEME_TEST_APK || resolve(project, "app/build/outputs/apk/deviceTest/MaiScoreHub-deviceTest.apk");
const dist = resolve(project, "../frontend/dist");
const packageName = "com.bakapiano.maiscorehub.android.devicetest";
const origin = "http://localhost:19310";
assert.match(serial || "", /^emulator-\d+$/);
const adb = async (...args) => (await exec(adbPath, ["-s", serial, ...args], { timeout: 60_000 })).stdout.trim();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(150);
  }
  throw new Error(`Timed out: ${description}`);
}

class DevTools {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((done, reject) => {
      this.socket.addEventListener("open", done, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools timeout: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const value = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  }
  close() { this.socket.close(); }
}

assert.equal(await adb("shell", "getprop", "ro.kernel.qemu"), "1");
assert.match(await adb("emu", "avd", "name"), /^msh-(?:native|theme)-api\d+/);
assert.equal(await adb("shell", "getprop", "sys.boot_completed"), "1", "Wait for the emulator to finish booting");
await stat(resolve(dist, "index.html"));
await mkdir(output, { recursive: true });
const oldNight = (await adb("shell", "cmd", "uimode", "night")).match(/Night mode: (\w+)/)?.[1];
assert.ok(oldNight, "Read original night-mode setting");
const oldReverse = (await adb("reverse", "--list")).split(/\r?\n/)
  .find((line) => /\stcp:19310\s/.test(line))?.trim().split(/\s+/).at(-1);
const results = { sdk: await adb("shell", "getprop", "ro.build.version.sdk"), checks: [] };
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, origin).pathname);
    const path = extname(pathname) ? resolve(dist, `.${pathname}`) : resolve(dist, "index.html");
    if (!path.startsWith(dist + sep)) throw new Error("Invalid fixture path");
    const body = await readFile(path);
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "connect-src 'self'; img-src 'self' data: blob:;",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
let cdp;
let forward;
let savedStorage;
let reversed = false;
let restoreNotificationPermission = false;
const storageKeys = ["mantine-color-scheme-value", "offline_mode"];
try {
  await new Promise((done, reject) => { server.once("error", reject); server.listen(19310, "127.0.0.1", done); });
  await adb("install", "-r", apk);
  if (Number(results.sdk) >= 33) {
    const packageInfo = await adb("shell", "dumpsys", "package", packageName);
    restoreNotificationPermission = !packageInfo.includes("android.permission.POST_NOTIFICATIONS: granted=true");
    await adb("shell", "pm", "grant", packageName, "android.permission.POST_NOTIFICATIONS");
  }
  await adb("reverse", "tcp:19310", "tcp:19310");
  reversed = true;
  await adb("shell", "input", "keyevent", "224");
  await adb("shell", "wm", "dismiss-keyguard");
  await adb("shell", "cmd", "uimode", "night", "yes");
  await adb("shell", "am", "start", "-W", "-n", `${packageName}/com.bakapiano.maiscorehub.android.MainActivity`);
  const pid = await adb("shell", "pidof", packageName);
  await until(async () => (await adb("shell", "cat", "/proc/net/unix")).includes(`webview_devtools_remote_${pid}`), "WebView debug socket");
  forward = await adb("forward", "tcp:0", `localabstract:webview_devtools_remote_${pid}`);
  const target = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${forward}/json/list`)).json();
    return targets.find((item) => item.type === "page" && item.url.startsWith(origin));
  }, "Local frontend WebView");
  cdp = new DevTools(target.webSocketDebuggerUrl);
  results.webView = (await cdp.send("Browser.getVersion")).product;
  savedStorage = await cdp.evaluate(`Object.fromEntries(${JSON.stringify(storageKeys)}.map(k => [k, localStorage.getItem(k)]))`);
  await cdp.evaluate(`localStorage.removeItem('mantine-color-scheme-value'); localStorage.setItem('offline_mode', '1'); location.replace('${origin}/app/settings')`);
  const state = () => cdp.evaluate(`({
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    scheme: document.documentElement?.getAttribute('data-mantine-color-scheme'),
    selection: document.querySelector('input[type=radio]:checked')?.value,
    saved: localStorage.getItem('mantine-color-scheme-value'),
    marker: window.__themeProbe?.marker,
    ticks: window.__themeProbe?.ticks,
    events: window.__themeProbe?.events,
    background: document.body ? getComputedStyle(document.body).backgroundColor : null,
    path: location.pathname
  })`);
  await until(async () => (await state()).selection, "Rendered real appearance settings");
  async function check(name, dark, scheme, selection, marker) {
    const s = await until(async () => {
      const s = await state();
      return s.dark === dark && s.scheme === scheme && s.selection === selection
        && (!marker || (s.marker === marker && s.ticks > 0)) ? s : false;
    }, name);
    assert.equal(s.background, scheme === "dark" ? "rgb(36, 36, 36)" : "rgb(255, 255, 255)", `${name}: rendered page color`);
    if (marker) {
      assert.equal(s.marker, marker, `${name}: same document and in-memory state`);
      assert.ok(s.ticks > 0, `${name}: JavaScript timer remains alive`);
    }
    assert.equal(await adb("shell", "pidof", packageName), pid, `${name}: same native process`);
    results.checks.push({ name, ...s });
    console.log(`PASS ${name} ${JSON.stringify(s)}`);
  }
  const marker = `theme-${Date.now()}`;
  const installProbe = () => cdp.evaluate(`window.__themeProbe = { marker: '${marker}', ticks: 0, events: [] };
    setInterval(() => window.__themeProbe.ticks++, 50);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => window.__themeProbe.events.push(e.matches))`);
  await installProbe();
  const choose = (value) => cdp.evaluate(`document.querySelector('input[type=radio][value=${value}]').click()`);
  const reload = async () => {
    await cdp.evaluate("window.__themeReload = true");
    await cdp.send("Page.reload");
    await until(() => cdp.evaluate("!window.__themeReload && document.readyState === 'complete' && !!document.querySelector('input[type=radio]:checked')"), "Reloaded settings document");
  };
  const night = (dark) => adb("shell", "cmd", "uimode", "night", dark ? "yes" : "no");
  const screenshot = async (name) => {
    // Wait for browser paint, then capture both its surface and the Android frame.
    await cdp.send("Runtime.evaluate", {
      expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
      awaitPromise: true,
    });
    const webImage = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(output, `${name}-webview.png`), Buffer.from(webImage.data, "base64"));
    await sleep(1_000);
    const { stdout } = await exec(adbPath, ["-s", serial, "exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    await writeFile(resolve(output, `${name}.png`), stdout);
  };
  await check("fresh-default-auto-dark", true, "dark", "auto", marker);
  await screenshot("auto-dark");
  await night(false);
  await check("auto-dark-to-light", false, "light", "auto", marker);
  await screenshot("auto-light");
  await night(true);
  await check("auto-light-to-dark", true, "dark", "auto", marker);
  await choose("light");
  await check("manual-light-on-dark-system", true, "light", "light", marker);
  await night(false);
  await check("manual-light-system-light", false, "light", "light", marker);
  await night(true);
  await check("manual-light-preserved", true, "light", "light", marker);
  await choose("dark");
  await night(false);
  await check("manual-dark-on-light-system", false, "dark", "dark", marker);
  await night(true);
  await check("manual-dark-preserved", true, "dark", "dark", marker);
  await reload();
  await check("manual-dark-persists-reload", true, "dark", "dark");
  await choose("auto");
  await night(false);
  await check("restore-auto", false, "light", "auto");
  await installProbe();
  await adb("shell", "input", "keyevent", "3");
  await night(true);
  await adb("shell", "am", "start", "-W", "-n", `${packageName}/com.bakapiano.maiscorehub.android.MainActivity`);
  await check("background-switch-resume", true, "dark", "auto", marker);
  await reload();
  await check("auto-persists-reload", true, "dark", "auto");
  results.passed = true;
} catch (error) {
  results.passed = false;
  results.failure = error.stack;
  if (cdp) results.page = await cdp.evaluate("({url:location.href,text:document.body.innerText.slice(0,1000),dark:matchMedia('(prefers-color-scheme: dark)').matches,scheme:document.documentElement.getAttribute('data-mantine-color-scheme')})").catch(() => null);
  process.exitCode = 1;
  console.error(error);
} finally {
  if (cdp && savedStorage) {
    await cdp.evaluate(`Object.entries(${JSON.stringify(savedStorage)}).forEach(([k,v]) => v === null ? localStorage.removeItem(k) : localStorage.setItem(k,v))`).catch(() => {});
  }
  cdp?.close();
  if (forward) await adb("forward", "--remove", `tcp:${forward}`);
  if (reversed) {
    await adb("shell", "am", "force-stop", packageName);
    if (oldReverse) await adb("reverse", "tcp:19310", oldReverse);
    else await adb("reverse", "--remove", "tcp:19310");
  }
  await adb("shell", "cmd", "uimode", "night", oldNight);
  if (restoreNotificationPermission) await adb("shell", "pm", "revoke", packageName, "android.permission.POST_NOTIFICATIONS");
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await writeFile(resolve(output, "results.json"), JSON.stringify(results, null, 2));
}
