import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const baseUrl = (
  process.env.PASSKEY_E2E_BASE_URL ?? 'http://localhost:3001'
).replace(/\/$/, '');
const browserCandidates = [
  process.env.PASSKEY_E2E_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const executablePath = browserCandidates.find((candidate) =>
  existsSync(candidate),
);

if (!executablePath) {
  throw new Error(
    'Chrome/Edge not found; set PASSKEY_E2E_BROWSER to a Chromium executable',
  );
}

const accountProof = ['E2e', randomUUID()].join('-');
const friendCode = `${String(Date.now()).slice(-13)}${Math.floor(
  Math.random() * 90 + 10,
)}`;
let token = '';
let browser;

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

async function createCredential(page, options) {
  return page.evaluate(async (optionsJSON) => {
    const decode = (value) => {
      const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
      return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    };
    const encode = (value) => {
      const bytes = new Uint8Array(value);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    };
    const publicKey = {
      ...optionsJSON,
      challenge: decode(optionsJSON.challenge),
      user: { ...optionsJSON.user, id: decode(optionsJSON.user.id) },
      excludeCredentials: (optionsJSON.excludeCredentials ?? []).map(
        (credential) => ({ ...credential, id: decode(credential.id) }),
      ),
    };
    const credential = await navigator.credentials.create({ publicKey });
    if (!(credential instanceof PublicKeyCredential)) {
      throw new Error('No public-key credential was created');
    }
    const response = credential.response;
    return {
      id: credential.id,
      rawId: encode(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: encode(response.clientDataJSON),
        attestationObject: encode(response.attestationObject),
        transports: response.getTransports?.() ?? [],
        publicKeyAlgorithm: response.getPublicKeyAlgorithm?.(),
        publicKey: response.getPublicKey?.()
          ? encode(response.getPublicKey())
          : undefined,
      },
    };
  }, options);
}

async function getCredential(page, options) {
  return page.evaluate(async (optionsJSON) => {
    const decode = (value) => {
      const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
      return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    };
    const encode = (value) => {
      const bytes = new Uint8Array(value);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    };
    const publicKey = {
      ...optionsJSON,
      challenge: decode(optionsJSON.challenge),
      allowCredentials: optionsJSON.allowCredentials?.map((credential) => ({
        ...credential,
        id: decode(credential.id),
      })),
    };
    const credential = await navigator.credentials.get({ publicKey });
    if (!(credential instanceof PublicKeyCredential)) {
      throw new Error('No public-key credential was returned');
    }
    const assertion = credential.response;
    return {
      id: credential.id,
      rawId: encode(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: encode(assertion.clientDataJSON),
        authenticatorData: encode(assertion.authenticatorData),
        signature: encode(assertion.signature),
        ...(assertion.userHandle
          ? { userHandle: encode(assertion.userHandle) }
          : {}),
      },
    };
  }, options);
}

async function register(page, name) {
  const optionsResult = await api('/me/passkeys/registration/options', {
    method: 'POST',
    body: JSON.stringify({ password: accountProof }),
  });
  assert.equal(optionsResult.status, 200, JSON.stringify(optionsResult.body));
  const response = await createCredential(page, optionsResult.body.options);
  const verifyResult = await api('/me/passkeys/registration/verify', {
    method: 'POST',
    body: JSON.stringify({
      ceremonyId: optionsResult.body.ceremonyId,
      name,
      response,
    }),
  });
  assert.equal(verifyResult.status, 201, JSON.stringify(verifyResult.body));
  return verifyResult.body;
}

try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  let { authenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });

  const login = await api('/auth/login-requests', {
    method: 'POST',
    body: JSON.stringify({ friendCode, method: 'bot_sends_request' }),
  });
  assert.equal(login.status, 201, JSON.stringify(login.body));
  assert.ok(login.body.token, 'SKIP_AUTH dev login did not return a token');
  token = login.body.token;

  const passwordRequired = await api('/me/passkeys/registration/options', {
    method: 'POST',
    body: JSON.stringify({ password: accountProof }),
  });
  assert.equal(passwordRequired.status, 409);
  assert.equal(passwordRequired.body.code, 'password_required');

  const setPassword = await api('/me/password', {
    method: 'PUT',
    body: JSON.stringify({ newPassword: accountProof }),
  });
  assert.equal(setPassword.status, 200, JSON.stringify(setPassword.body));

  const firstPasskey = await register(page, 'E2E Chrome');
  const listed = await api('/me/passkeys');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].name, 'E2E Chrome');

  const renamed = await api(`/me/passkeys/${firstPasskey.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'E2E Renamed' }),
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.name, 'E2E Renamed');

  await page.getByRole('tab', { name: '网站密钥' }).click();
  await page.getByRole('button', { name: '使用网站密钥登录' }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 15_000 });
  const browserToken = await page.evaluate(() =>
    localStorage.getItem('netbot_token'),
  );
  assert.ok(browserToken, 'Frontend Passkey login did not persist a token');
  const usedPasskeys = await api('/me/passkeys');
  assert.equal(usedPasskeys.status, 200);
  assert.ok(usedPasskeys.body[0].lastUsedAt);

  const authenticationOptions = await api('/auth/passkey/options', {
    method: 'POST',
  });
  assert.equal(authenticationOptions.status, 200);
  const assertion = await getCredential(
    page,
    authenticationOptions.body.options,
  );
  const authenticated = await api('/auth/passkey/verify', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({
      ceremonyId: authenticationOptions.body.ceremonyId,
      response: assertion,
    }),
  });
  assert.equal(authenticated.status, 200, JSON.stringify(authenticated.body));
  assert.ok(authenticated.body.token);

  const replay = await api('/auth/passkey/verify', {
    method: 'POST',
    body: JSON.stringify({
      ceremonyId: authenticationOptions.body.ceremonyId,
      response: assertion,
    }),
  });
  assert.equal(replay.status, 400, JSON.stringify(replay.body));
  assert.equal(replay.body.code, 'challenge_expired');

  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }));
  const secondPasskey = await register(page, 'E2E Second Device');
  const multiplePasskeys = await api('/me/passkeys');
  assert.equal(multiplePasskeys.status, 200);
  assert.equal(multiplePasskeys.body.length, 2);

  const wrongPasswordDelete = await api(
    `/me/passkeys/${secondPasskey.id}/delete`,
    {
      method: 'POST',
      body: JSON.stringify({ password: `${accountProof}-wrong` }),
    },
  );
  assert.equal(wrongPasswordDelete.status, 403);
  assert.equal(wrongPasswordDelete.body.code, 'invalid_password');

  const deleted = await api(`/me/passkeys/${secondPasskey.id}/delete`, {
    method: 'POST',
    body: JSON.stringify({ password: accountProof }),
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const firstDeleted = await api(`/me/passkeys/${firstPasskey.id}/delete`, {
    method: 'POST',
    body: JSON.stringify({ password: accountProof }),
  });
  assert.equal(firstDeleted.status, 200, JSON.stringify(firstDeleted.body));

  const unknownOptions = await api('/auth/passkey/options', { method: 'POST' });
  const unknownAssertion = await getCredential(
    page,
    unknownOptions.body.options,
  );
  const unknownCredential = await api('/auth/passkey/verify', {
    method: 'POST',
    body: JSON.stringify({
      ceremonyId: unknownOptions.body.ceremonyId,
      response: unknownAssertion,
    }),
  });
  assert.equal(
    unknownCredential.status,
    401,
    JSON.stringify(unknownCredential.body),
  );
  assert.equal(unknownCredential.body.code, 'invalid_passkey');

  await register(page, 'E2E Cascade');
  const accountDelete = await api('/me', { method: 'DELETE' });
  assert.equal(accountDelete.status, 200, JSON.stringify(accountDelete.body));
  assert.equal(accountDelete.body.deleted.passkeys, 1);

  console.log(
    'Passkey dev E2E passed: password-gate/multiple/list/rename/frontend-login/api-login/replay/delete/cascade',
  );
} finally {
  if (token) {
    await api('/me', { method: 'DELETE' }).catch(() => undefined);
  }
  await browser?.close();
}
