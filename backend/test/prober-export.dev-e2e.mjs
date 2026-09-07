// Run against a local Vite + Backend dev stack with SKIP_AUTH=true.
// Real requests cover missing scores/tokens. Fault/success cases stub only
// the named API response; no scores are uploaded to an external provider.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const baseUrl = (
  process.env.PROBER_EXPORT_E2E_BASE_URL ?? 'http://localhost:3001'
).replace(/\/$/, '');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname),
  'This test creates a temporary account and requires a loopback dev URL',
);
const executablePath = [
  process.env.PROBER_EXPORT_E2E_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((path) => path && existsSync(path));
assert.ok(executablePath, 'Set PROBER_EXPORT_E2E_BROWSER to a Chromium binary');

const artifactDir = resolve('../.local-dev/prober-export-e2e', randomUUID());
mkdirSync(artifactDir, { recursive: true });
const friendCode = `999${String(Date.now()).slice(-9)}${randomInt(100, 1000)}`;
const tokens = {
  divingFishImportToken: `local-e2e-${randomUUID()}`,
  lxnsImportToken: `local-e2e-${randomUUID()}`,
};
const scoreGuidance = '请先完成一次成绩同步，再导出到查分器。';
const results = [];
const pageErrors = [];
let token = '';
let browser;
let page;

async function api(path, method = 'GET', body) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function panel(provider) {
  return page.locator('[class*="proberPanel"]').filter({
    has: page.getByRole('link', {
      name: provider === 'diving-fish' ? '水鱼查分器' : '落雪查分器',
      exact: true,
    }),
  });
}

async function openSync() {
  await page.goto(`${baseUrl}/app/sync`);
  await panel('diving-fish')
    .getByRole('button', { name: '更新成绩', exact: true })
    .waitFor();
}

async function assertMessage(expected) {
  await page.getByText(expected, { exact: true }).waitFor({ state: 'visible' });
  assert.equal(
    await page.getByText('请检查 Token 是否正确！', { exact: false }).count(),
    0,
  );
}

async function exportAndCheck(provider, status, expected) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/me/sync/latest/exports/${provider}`),
  );
  await panel(provider)
    .getByRole('button', { name: '更新成绩', exact: true })
    .click();
  const response = await responsePromise;
  assert.equal(response.status(), status);
  await assertMessage(expected);
  return response.json();
}

async function scenario(name, run) {
  await openSync();
  await run();
  results.push(name);
  console.log(`PASS ${name}`);
}

try {
  const login = await api('/auth/login-requests', 'POST', {
    friendCode,
    method: 'bot_sends_request',
  });
  assert.equal(login.status, 201);
  assert.equal(
    login.body.skipAuth,
    true,
    'Requires a dev backend with SKIP_AUTH=true',
  );
  token = login.body.token;
  assert.ok(token);
  assert.equal((await api('/me', 'PATCH', tokens)).status, 200);
  assert.equal((await api('/me/sync/latest')).status, 404);

  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === new URL(baseUrl).origin ||
      ['data:', 'blob:'].includes(url.protocol)
      ? route.continue()
      : route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/login`);
  await page.getByRole('tab', { name: '好友码', exact: true }).click();
  await page
    .getByPlaceholder('请输入 NET 好友代码', { exact: true })
    .fill(friendCode);
  await page.getByRole('button', { name: '登录账户', exact: true }).click();
  await page.waitForURL('**/app');

  for (const provider of ['diving-fish', 'lxns']) {
    await scenario(`${provider}: real missing-sync 404`, async () => {
      const body = await exportAndCheck(provider, 404, scoreGuidance);
      assert.equal(body.message, 'Sync not found');
      await page.screenshot({
        path: resolve(artifactDir, `${provider}-missing-sync.png`),
        fullPage: true,
        animations: 'disabled',
      });
    });
  }

  for (const [provider, field, title] of [
    ['diving-fish', 'divingFishImportToken', '水鱼查分器'],
    ['lxns', 'lxnsImportToken', '落雪查分器'],
  ]) {
    await scenario(`${provider}: real missing-token 400`, async () => {
      // Keep the rendered configured state, then simulate credentials removed
      // by another session before the export request reaches the backend.
      assert.equal((await api('/me', 'PATCH', { [field]: null })).status, 200);
      try {
        await exportAndCheck(provider, 400, `请先配置${title}的导入 Token。`);
      } finally {
        assert.equal(
          (await api('/me', 'PATCH', { [field]: tokens[field] })).status,
          200,
        );
      }
    });
  }

  const exportRoute = '**/api/v1/me/sync/latest/exports/diving-fish';
  for (const [status, body, expected] of [
    [500, { message: 'Internal server error' }, 'Internal server error'],
    [404, { message: 'User not found' }, 'User not found'],
    [201, {}, '导出服务响应异常，请稍后重试。'],
  ]) {
    await scenario(`response stub: export ${status} ${expected}`, async () => {
      await page.route(
        exportRoute,
        (route) => route.fulfill({ status, json: body }),
        { times: 1 },
      );
      await exportAndCheck('diving-fish', status, expected);
    });
  }

  for (const success of [false, true]) {
    await scenario(
      `response stub: background export ${success ? 'success' : 'failure'}`,
      async () => {
        const id = `e2e-${randomUUID()}`;
        await page.route(
          exportRoute,
          (route) =>
            route.fulfill({
              status: 201,
              json: { exportJobId: id, status: 'queued' },
            }),
          { times: 1 },
        );
        await page.route(
          `**/api/v1/me/sync/prober-export-jobs/${id}`,
          (route) =>
            route.fulfill({
              json: {
                id,
                status: success ? 'completed' : 'failed',
                result: {
                  divingFish: {
                    status: success ? 'success' : 'failed',
                    message: 'E2E provider failure',
                    exported: 1,
                    scores: 1,
                  },
                },
              },
            }),
          { times: 1 },
        );
        await exportAndCheck(
          'diving-fish',
          201,
          success
            ? '成绩已导出到 Diving-Fish（共 1 条成绩，导出 1 条）'
            : 'E2E provider failure',
        );
      },
    );
  }

  for (const success of [false, true]) {
    await scenario(
      `login response stub: ${success ? 'success then real missing-sync 404' : 'authentication failure'}`,
      async () => {
        await panel('diving-fish')
          .getByRole('button', { name: '修改凭据', exact: true })
          .click();
        await panel('diving-fish')
          .getByRole('tab', { name: '账号密码', exact: true })
          .click();
        await panel('diving-fish')
          .getByLabel('用户名', { exact: true })
          .fill('local-e2e');
        await panel('diving-fish')
          .getByLabel('密码', { exact: true })
          .fill('local-e2e-placeholder');
        const authError = '水鱼登录失败 (HTTP 401): 用户名或密码错误';
        await page.route(
          '**/api/v1/me/prober-tokens/diving-fish',
          (route) =>
            route.fulfill({
              status: success ? 201 : 400,
              json: success
                ? { importToken: tokens.divingFishImportToken }
                : { message: authError },
            }),
          { times: 1 },
        );
        const responsePromise = success
          ? page.waitForResponse(
              (response) =>
                response.request().method() === 'POST' &&
                response.url().endsWith('/me/sync/latest/exports/diving-fish'),
            )
          : null;
        await panel('diving-fish')
          .getByRole('button', { name: '获取 Token 并更新', exact: true })
          .click();
        if (responsePromise) {
          assert.equal((await responsePromise).status(), 404);
        }
        await assertMessage(success ? scoreGuidance : authError);
      },
    );
  }

  assert.deepEqual(pageErrors, [], 'Browser runtime errors');
  console.log(
    JSON.stringify(
      { passed: results.length, pageErrors, artifactDir },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: resolve(artifactDir, 'failure.png'), fullPage: true })
      .catch(() => {});
  }
  console.error(`E2E failure artifacts: ${artifactDir}`);
  throw error;
} finally {
  await browser?.close();
  if (token) {
    const removed = await api('/me', 'DELETE');
    assert.equal(removed.status, 200, 'Temporary test-account cleanup');
    console.log('Temporary dev test account removed');
  }
}
