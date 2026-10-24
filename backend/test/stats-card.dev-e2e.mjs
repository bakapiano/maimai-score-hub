import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient, ObjectId } from 'mongodb';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '../..');
const runId = randomBytes(6).toString('hex');
const database = 'msh_stats_card_e2e_' + runId;
const output = path.join(root, '.local-dev/stats-card-e2e', runId);
mkdirSync(output, { recursive: true });
const children = [];
const logs = [];
let browser;
let mongo;
let successful = false;
const fixtures = ['799999999999901', '799999999999902'];
const profile = {
  username: '舞萌玩家',
  title: '热爱音乐，享受每一次相遇',
  titleColor: 'gold',
  rating: 15432,
  awakeningCount: 42,
  avatarUrl: null,
  courseRankUrl: null,
  classRankUrl: null,
  ratingBgUrl: null,
};

function localSettings() {
  const file = path.join(root, '.env.local-dev');
  const settings = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) {
        settings[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  return settings;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function start(name, exe, args, cwd, env) {
  const log = createWriteStream(path.join(output, name + '.log'));
  logs.push(log);
  const child = spawn(exe, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('error', (error) => {
    log.write(String(error));
  });
  children.push(child);
  return child;
}
async function ready(url) {
  for (let i = 0; i < 160; i++) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) {
      return;
    }
    const failed = children.find((child) => child.exitCode !== null);
    if (failed) {
      throw new Error('Local process exited; inspect ' + output);
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for ' + url + '; logs: ' + output);
}
async function json(base, route, token, method = 'GET', body) {
  const response = await fetch(base + '/api/v1' + route, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, status: response.status, body: await response.json() };
}
async function image(base, code, theme = 'light', extra = {}) {
  const response = await fetch(
    base + '/api/v1/stats/' + code + '/card.svg?theme=' + theme,
    {
      headers: { 'Accept-Encoding': 'identity', ...extra },
    },
  );
  return { response, status: response.status, body: await response.text() };
}
async function previewReady(page) {
  const img = page.getByAltText('个人名片 SVG 预览');
  await img.waitFor();
  await img.evaluate((el) =>
    el.complete && el.naturalWidth > 0
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          el.onload = resolve;
          el.onerror = () => reject(new Error('SVG preview failed to load'));
        }),
  );
}
async function assertStablePreviewUpdate(page, action) {
  // Measure the update, not the modal's initial entrance transition.
  await delay(350);
  const routePattern = '**/me/stats-card/preview.svg*';
  await page.route(routePattern, async (route) => {
    await delay(350);
    await route.continue();
  });
  await page.evaluate(() => {
    window.cardLayoutSamples = [];
    window.cardLayoutSampling = true;
    const sample = () => {
      if (!window.cardLayoutSampling) return;
      const modal = document
        .querySelector('[role="dialog"]')
        .getBoundingClientRect();
      const preview = document
        .querySelector('[aria-label="名片预览区域"]')
        .getBoundingClientRect();
      window.cardLayoutSamples.push({
        top: modal.top,
        height: modal.height,
        previewHeight: preview.height,
      });
      requestAnimationFrame(sample);
    };
    sample();
  });
  try {
    const updated = page.waitForResponse(
      (response) =>
        response.url().includes('/preview.svg?') && response.status() === 200,
    );
    await Promise.all([updated, action()]);
    await previewReady(page);
    await delay(100);
    const samples = await page.evaluate(() => {
      window.cardLayoutSampling = false;
      return window.cardLayoutSamples;
    });
    assert.ok(
      samples.length > 5,
      'Must sample through the delayed loading state',
    );
    for (const key of ['top', 'height', 'previewHeight']) {
      const values = samples.map((sample) => sample[key]);
      assert.ok(
        Math.max(...values) - Math.min(...values) <= 1,
        'Preview update shifted ' +
          key +
          ': ' +
          Math.min(...values) +
          ' -> ' +
          Math.max(...values),
      );
    }
  } finally {
    await page.evaluate(() => {
      window.cardLayoutSampling = false;
    });
    await page.unroute(routePattern);
  }
}

function noPrivateData(svg) {
  for (const value of [
    ...fixtures,
    'private-import-token',
    'cabinetUserId',
    'friendCode',
    '<script',
    '<foreignObject',
  ]) {
    assert.ok(
      !svg.includes(value),
      'SVG leaked private/active content: ' + value,
    );
  }
  assert.match(svg, /<svg/);
  assert.ok(Buffer.byteLength(svg) <= 256 * 1024);
}

try {
  const settings = localSettings();
  const user =
    process.env.STATS_CARD_E2E_MONGO_USER ?? settings.MONGO_USER ?? '';
  const password =
    process.env.STATS_CARD_E2E_MONGO_PASSWORD ?? settings.MONGO_PASSWORD ?? '';
  const authSource = settings.MONGO_AUTH_SOURCE ?? 'admin';
  const mongoPort = Number(process.env.STATS_CARD_E2E_MONGO_PORT ?? 27017);
  const mongoUri =
    'mongodb://' +
    (user && password
      ? encodeURIComponent(user) + ':' + encodeURIComponent(password) + '@'
      : '') +
    '127.0.0.1:' +
    mongoPort +
    '/?authSource=' +
    encodeURIComponent(authSource);
  mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });
  await mongo.connect();
  const db = mongo.db(database);
  const userIds = fixtures.map(() => new ObjectId());
  await db.collection('userentities').insertMany(
    fixtures.map((friendCode, index) => ({
      _id: userIds[index],
      friendCode,
      profile,
      autoUpdate: false,
      divingFishImportToken: 'private-import-token',
      cabinetUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  // The collection name is derived from the existing UserEntity Mongoose model.
  const redisPort = await freePort();
  const redisExe =
    process.env.STATS_CARD_E2E_REDIS_BIN ??
    'C:/ProgramData/chocolatey/lib/memurai-developer.portable/tools/memurai.exe';
  assert.ok(
    existsSync(redisExe),
    'Set STATS_CARD_E2E_REDIS_BIN to a local Redis/Memurai binary',
  );
  start(
    'redis',
    redisExe,
    [
      '--bind',
      '127.0.0.1',
      '--port',
      String(redisPort),
      '--dir',
      output,
      '--save',
      '',
      '--appendonly',
      'no',
    ],
    root,
    process.env,
  );
  const portA = await freePort();
  const portB = await freePort();
  const frontPort = await freePort();
  const baseA = 'http://127.0.0.1:' + portA;
  const baseB = 'http://127.0.0.1:' + portB;
  const front = 'http://127.0.0.1:' + frontPort;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    MONGO_HOST: '127.0.0.1',
    MONGO_PORT: String(mongoPort),
    MONGO_DB: database,
    MONGO_USER: user,
    MONGO_PASSWORD: password,
    MONGO_AUTH_SOURCE: authSource,
    REDIS_URL: 'redis://127.0.0.1:' + redisPort,
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: String(redisPort),
    REDIS_PASSWORD: '',
    REDIS_DB: '0',
    REDIS_KEY_PREFIX: 'stats-e2e:' + runId + ':',
    BULLMQ_PREFIX: 'stats-e2e-' + runId,
    AUTH_JWT_SECRET: 'stats-card-e2e-only-' + runId,
    SKIP_AUTH: 'true',
    ADMIN_PASSWORD: 'stats-card-local-test',
    API_SHARED_SECRET: 'stats-card-local-test',
    OBSERVABILITY_ENABLED: 'false',
    MUSIC_SYNC_CRON: '0 0 1 1 *',
    ALIAS_SYNC_CRON: '0 0 1 1 *',
    ALIAS_SYNC_ON_STARTUP: 'false',
    CORS_ORIGINS: 'http://localhost:3001,' + front,
  };
  for (const [name, port] of [
    ['backend-a', portA],
    ['backend-b', portB],
  ]) {
    start(
      name,
      process.execPath,
      ['dist/main.js'],
      path.join(root, 'backend'),
      { ...env, PORT: String(port) },
    );
  }
  start(
    'frontend',
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(frontPort),
      '--strictPort',
    ],
    path.join(root, 'frontend'),
    {
      ...process.env,
      FRONTEND_API_PROXY_TARGET: baseA,
      VITE_API_BASE_URL: '/api/v1',
    },
  );
  await Promise.all([
    ready(baseA + '/api/v1/health'),
    ready(baseB + '/api/v1/health'),
    ready(front),
  ]);
  console.log(
    'Ready: two real backend replicas, Vite, isolated MongoDB and Redis',
  );
  const login = await json(baseA, '/auth/login-requests', '', 'POST', {
    friendCode: fixtures[0],
    method: 'bot_sends_request',
  });
  assert.equal(login.status, 201);
  const token = login.body.token;
  assert.ok(token);
  // UserEntity's actual collection is verified before UI tests.
  const me = await json(baseA, '/me', token);
  assert.equal(
    me.body.profile?.username,
    profile.username,
    'Fixture collection mismatch',
  );
  assert.equal((await json(baseA, '/me/stats-card', '')).status, 401);
  assert.equal(
    (
      await json(baseA, '/me/stats-card', token, 'POST', {
        userId: String(userIds[1]),
      })
    ).status,
    400,
  );
  const privatePreview = await fetch(
    baseA + '/api/v1/me/stats-card/preview.svg',
    {
      headers: { Authorization: 'Bearer ' + token },
    },
  );
  assert.equal(privatePreview.status, 200);
  assert.equal(privatePreview.headers.get('cache-control'), 'no-store');
  noPrivateData(await privatePreview.text());
  assert.equal(await db.collection('stats_card_shares').countDocuments(), 0);
  console.log(
    'PASS private preview, authentication, explicit opt-in and identity override rejection',
  );

  const executablePath =
    process.env.STATS_CARD_E2E_BROWSER ??
    'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (
      url.protocol.startsWith('http') &&
      !['localhost', '127.0.0.1'].includes(url.hostname)
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  await context.addInitScript(
    (value) => localStorage.setItem('netbot_token', value),
    token,
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(front + '/app/sync');
  assert.equal(
    await page
      .getByRole('button', { name: '舞萌名片外链', exact: true })
      .count(),
    0,
  );
  await page.goto(front + '/app/settings');
  await page.getByRole('button', { name: '舞萌名片外链', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await previewReady(page);
  assert.equal(await db.collection('stats_card_shares').countDocuments(), 0);
  const dialog = page.getByRole('dialog');
  assert.equal(
    await dialog
      .getByText('任何拿到链接的人都能查看和转发，请注意隐私保护', {
        exact: true,
      })
      .count(),
    1,
  );
  assert.equal(
    await dialog.getByText('生成并分享舞萌名片外链', { exact: false }).count(),
    0,
  );
  assert.equal(await dialog.locator('.mantine-Modal-title svg').count(), 1);
  assert.equal(await dialog.getByRole('switch').count(), 5);
  assert.equal(await dialog.getByText(/自动保存|保存中/).count(), 0);
  // Options can be saved before opt-in, without creating any publicly readable code.
  await assertStablePreviewUpdate(page, () =>
    dialog.getByText('Rating', { exact: true }).click(),
  );
  await previewReady(page);
  const beforeEnable = await json(baseA, '/me/stats-card', token);
  assert.equal(beforeEnable.body.enabled, false);
  assert.equal(beforeEnable.body.code, null);
  assert.equal(beforeEnable.body.display.rating, false);
  const hiddenPreview = await fetch(
    baseA + '/api/v1/me/stats-card/preview.svg',
    { headers: { Authorization: 'Bearer ' + token } },
  );
  assert.ok(!(await hiddenPreview.text()).includes('data-part="rating-text"'));
  await page.getByRole('button', { name: '生成外链', exact: true }).click();
  const input = page.getByLabel('SVG 图片外链');
  await input.waitFor();
  const firstUrl = await input.inputValue();
  const firstCode = new URL(firstUrl).pathname.split('/')[2];
  assert.match(firstCode, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!firstUrl.includes(fixtures[0]));
  const embedded = await fetch(firstUrl);
  assert.equal(embedded.status, 200);
  assert.match(embedded.headers.get('content-type'), /image\/svg\+xml/);
  const firstSvg = await embedded.text();
  noPrivateData(firstSvg);
  assert.ok(!firstSvg.includes('data-part="rating-text"'));
  assert.equal(
    await page.evaluate(
      (url) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth === 560);
          img.onerror = () => resolve(false);
          img.src = url;
        }),
      firstUrl,
    ),
    true,
    'Public SVG failed to render as an embedded image',
  );
  await page.getByRole('button', { name: '复制链接', exact: true }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    firstUrl,
  );
  assert.equal(
    await dialog.getByRole('button', { name: /Markdown|HTML/ }).count(),
    0,
  );
  const management = dialog.getByRole('region', { name: '分享管理' });
  assert.equal(await management.getByLabel('SVG 图片外链').count(), 1);
  assert.equal(
    await management.getByRole('button', { name: /复制链接|已复制/ }).count(),
    1,
  );
  assert.equal(await dialog.getByText('名片预览', { exact: true }).count(), 1);
  assert.equal(await dialog.getByText('SVG 预览', { exact: true }).count(), 0);
  assert.equal(
    await management.getByText('分享已开启', { exact: true }).count(),
    1,
  );
  assert.equal(
    await dialog.getByLabel('名片预览操作')
      .getByRole('button', { name: '刷新预览', exact: true })
      .count(),
    1,
  );
  assert.equal(
    await management
      .getByRole('button', { name: '重置链接', exact: true })
      .count(),
    1,
  );
  assert.equal(
    await management
      .getByRole('button', { name: '关闭分享', exact: true })
      .count(),
    1,
  );
  // Save every option through the UI; verify the other replica never serves its old image.
  for (const [key, label, part] of [
    ['awakeningCount', '觉醒数', 'star-count'],
    ['classRank', '友人对战段位', 'class-rank'],
    ['courseRank', '课题段位', 'course-rank'],
    ['title', '称号', 'title-text'],
  ]) {
    const oldImage = await image(baseB, firstCode);
    const [saved] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === 'PATCH' &&
          res.url().endsWith('/me/stats-card'),
      ),
      dialog.getByText(label, { exact: true }).click(),
    ]);
    assert.equal(saved.status(), 200);
    await previewReady(page);
    const after = await json(baseB, '/me/stats-card', token);
    assert.equal(after.body.display[key], false);
    assert.equal(after.body.code, firstCode);
    const updated = await image(baseB, firstCode);
    assert.equal(updated.status, 200);
    assert.ok(!updated.body.includes('data-part="' + part + '"'));
    if (oldImage.body.includes('data-part="' + part + '"')) {
      const conditional = await image(baseB, firstCode, 'light', {
        'If-None-Match': oldImage.response.headers.get('etag'),
      });
      assert.equal(
        conditional.status,
        200,
        'Must not validate stale hidden content',
      );
    }
  }
  assert.equal(
    (await image(baseB, firstCode, 'light&rating=true')).status,
    400,
  );
  await dialog.getByRole('button', { name: '关闭名片弹窗' }).click();
  await page.getByRole('button', { name: '舞萌名片外链', exact: true }).click();
  await previewReady(page);
  for (const checkbox of await dialog.getByRole('switch').all()) {
    assert.equal(await checkbox.isChecked(), false);
  }
  // Restore all fields before the later profile-change regression tests.
  const restore = await json(baseA, '/me/stats-card', token, 'PATCH', {
    rating: true,
    awakeningCount: true,
    classRank: true,
    courseRank: true,
    title: true,
  });
  assert.equal(restore.status, 200);
  await dialog.getByLabel('名片预览操作').getByRole('button', { name: '刷新预览' }).click();
  await previewReady(page);
  await page.screenshot({
    path: path.join(output, 'desktop-modal.png'),
    fullPage: true,
  });
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes('/preview.svg?theme=dark') && res.status() === 200,
    ),
    page.getByRole('dialog').getByText('深色', { exact: true }).click(),
  ]);
  await previewReady(page);
  assert.match(await input.inputValue(), /theme=dark$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await delay(350);
  const modalRect = await dialog.boundingBox();
  assert.ok(
    modalRect &&
      Math.abs(modalRect.width - 390) < 2 &&
      Math.abs(modalRect.height - 844) < 2,
    'Mobile modal must fill the viewport',
  );
  await assertStablePreviewUpdate(page, () =>
    dialog.getByText('Rating', { exact: true }).click(),
  );
  await assertStablePreviewUpdate(page, () =>
    dialog.getByText('Rating', { exact: true }).click(),
  );
  await page.screenshot({
    path: path.join(output, 'mobile-modal.png'),
    fullPage: true,
  });
  const previewBounds = await page.getByAltText('个人名片 SVG 预览').boundingBox();
  assert.ok(previewBounds && previewBounds.x >= 0 && previewBounds.x + previewBounds.width <= 390,
    'Preview must stay inside the mobile viewport');
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  const warmed = await image(baseB, firstCode);
  assert.equal(warmed.status, 200);
  await page.getByRole('button', { name: '重置链接', exact: true }).click();
  await page.getByRole('button', { name: '确认重置', exact: true }).click();
  await page.waitForFunction(
    (old) => document.querySelector('input[readonly]')?.value !== old,
    firstUrl.replace('theme=light', 'theme=dark'),
  );
  const rotatedCode = new URL(await input.inputValue()).pathname.split('/')[2];
  assert.notEqual(rotatedCode, firstCode);
  const revoked = await image(baseB, firstCode, 'light', {
    'If-None-Match': warmed.response.headers.get('etag'),
  });
  assert.equal(revoked.status, 404);
  assert.equal(revoked.response.headers.get('cache-control'), 'no-store');
  await page.getByRole('button', { name: '关闭分享', exact: true }).click();
  await page.getByRole('button', { name: '确认关闭', exact: true }).click();
  await page.getByRole('button', { name: '生成外链', exact: true }).waitFor();
  assert.equal((await image(baseB, rotatedCode)).status, 404);
  assert.deepEqual(errors, []);
  console.log(
    'PASS browser preview, sharing, clipboard, themes, mobile layout, rotation and revocation across replicas',
  );

  const created = await json(baseA, '/me/stats-card', token, 'POST', {});
  assert.equal(created.status, 200);
  const code = created.body.code;
  assert.notEqual(code, rotatedCode);
  assert.equal(
    (await json(baseA, '/me/stats-card', token, 'POST', {})).body.code,
    code,
  );
  const light = await image(baseA, code);
  const dark = await image(baseB, code, 'dark');
  assert.equal(light.status, 200);
  assert.equal(dark.status, 200);
  noPrivateData(light.body);
  noPrivateData(dark.body);
  assert.notEqual(
    light.response.headers.get('etag'),
    dark.response.headers.get('etag'),
  );
  const etag = light.response.headers.get('etag');
  assert.equal(
    (await image(baseB, code, 'light', { 'If-None-Match': etag })).status,
    304,
  );
  assert.equal(
    (
      await fetch(baseA + '/api/v1/stats/' + code + '/card.svg', {
        method: 'HEAD',
      })
    ).status,
    200,
  );
  assert.equal(
    (await image(baseA, code, 'light&friendCode=' + fixtures[0])).status,
    400,
  );
  assert.equal((await image(baseA, code, 'custom')).status, 400);
  const artifacts = db.collection('stats_card_artifacts');
  assert.equal(await artifacts.countDocuments(), 2);
  for (const value of [15433, 15434, 15435]) {
    await db
      .collection('userentities')
      .updateOne({ _id: userIds[0] }, { $set: { 'profile.rating': value } });
    const refreshed = await image(baseB, code, 'light', {
      'If-None-Match': etag,
    });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.response.headers.get('etag'), etag);
    assert.equal(
      await artifacts.countDocuments(),
      2,
      'Historical artifacts accumulated',
    );
  }
  writeFileSync(path.join(output, 'card-light.svg'), light.body);
  writeFileSync(path.join(output, 'card-dark.svg'), dark.body);
  const stored = await artifacts.findOne({ theme: 'light' });
  console.log(
    'SVG bytes: ' +
      Buffer.byteLength(light.body) +
      '; stored gzip bytes: ' +
      stored.svgGzip.buffer.length,
  );
  const indexes = await artifacts.indexes();
  assert.ok(
    indexes.some(
      (index) =>
        index.unique && index.key.shareId === 1 && index.key.theme === 1,
    ),
  );
  assert.equal((await json(baseA, '/me', token, 'DELETE')).status, 200);
  assert.equal(
    (await image(baseB, code, 'light', { 'If-None-Match': etag })).status,
    404,
  );
  assert.equal(await db.collection('stats_card_shares').countDocuments(), 0);
  assert.equal(await artifacts.countDocuments(), 0);
  console.log(
    'PASS ETag/HEAD, two-theme bounded storage, fresh profiles, latest-only replacement and account deletion',
  );
  const secondLogin = await json(baseB, '/auth/login-requests', '', 'POST', {
    friendCode: fixtures[1],
    method: 'bot_sends_request',
  });
  const secondToken = secondLogin.body.token;
  const simultaneous = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      json(i % 2 ? baseA : baseB, '/me/stats-card', secondToken, 'POST', {}),
    ),
  );
  assert.ok(simultaneous.every((result) => result.status === 200));
  assert.equal(new Set(simultaneous.map((result) => result.body.code)).size, 1);
  assert.equal(await db.collection('stats_card_shares').countDocuments(), 1);
  const secondCode = simultaneous[0].body.code;
  const coldReads = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      image(i % 2 ? baseA : baseB, secondCode, i % 3 ? 'light' : 'dark'),
    ),
  );
  assert.ok(coldReads.every((result) => result.status === 200));
  assert.equal(await artifacts.countDocuments(), 2);
  assert.equal((await json(baseB, '/me', secondToken, 'DELETE')).status, 200);
  assert.equal(await artifacts.countDocuments(), 0);
  console.log(
    'PASS concurrent opt-in and cold rendering across two replicas without duplicate rows',
  );
  successful = true;
  console.log('PASS local stats-card E2E. Artifacts: ' + output);
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  await delay(1000);
  for (const log of logs) {
    log.end();
  }
  if (mongo) {
    // Exact loopback, run-scoped test database only. Never drop any user's dev DB.
    assert.match(database, /^msh_stats_card_e2e_[a-f0-9]{12}$/);
    await mongo
      .db(database)
      .dropDatabase()
      .catch(() => undefined);
    await mongo.close();
  }
  if (!successful) {
    console.error('E2E failed; diagnostic logs retained at ' + output);
  }
}
