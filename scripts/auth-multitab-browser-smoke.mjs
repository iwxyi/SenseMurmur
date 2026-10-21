import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const clientUrl = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5185';
const cdpUrl = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';
const reportDir = resolve(process.env.PNEUMATA_AUTH_REPORT_DIR || '../tmp/auth-browser');
const httpSmoke = process.env.PNEUMATA_AUTH_HTTP_SMOKE === '1';
const authKey = 'pneumata-auth-session';
const lockName = 'pneumata-auth-session-update';
const users = {
  a: { id: 'auth-smoke-a', phone: '19999990001', nickname: 'Smoke A', avatar: '', cloudSyncEntitled: false },
  b: { id: 'auth-smoke-b', phone: '19999990002', nickname: 'Smoke B', avatar: '', cloudSyncEntitled: false },
};

class Cdp {
  pending = new Map();
  listeners = new Set();
  nextId = 1;
  async open(url) {
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data.toString());
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        for (const listener of this.listeners) listener(message);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(page, expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.ws.close(); }
}

const cdp = new Cdp();
const version = await (await fetch(`${cdpUrl}/json/version`)).json();
await cdp.open(version.webSocketDebuggerUrl);
const { browserContextId } = await cdp.send('Target.createBrowserContext');
const requests = [];
const errors = [];
const results = [];
let pendingLogins = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only synthetic accounts are served. No request reaches a real account or supplier.
cdp.listeners.add((message) => {
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
  if (message.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = message.params;
  const path = new URL(request.url).pathname;
  const body = request.postData ? JSON.parse(request.postData) : {};
  requests.push({ path, method: request.method });
  let payload;
  let status = 200;
  if (path === '/api/auth/password-login' || path === '/api/auth/login') {
    const name = body.phone === users.a.phone ? 'a' : body.phone === users.b.phone ? 'b' : null;
    assert.ok(name, 'Only fixture accounts can log in');
    pendingLogins += 1;
    payload = { token: `fixture-${name}`, refreshToken: `refresh-${name}`, user: users[name] };
  } else if (path === '/api/auth/me') {
    const token = request.headers.Authorization || request.headers.authorization;
    const name = token === 'Bearer fixture-a' ? 'a' : token === 'Bearer fixture-b' ? 'b' : null;
    payload = name ? users[name] : { error: 'Unknown fixture session' };
    if (!name) status = 401;
  } else if (path === '/api/auth/logout') payload = { success: true };
  else if (path === '/api/platform/public-config') payload = { site: { name: 'Auth smoke' } };
  else if (path === '/api/usage/sessions/start') payload = { sessionId: 'auth-smoke-usage', heartbeatIntervalMs: 60000 };
  else if (/^\/api\/usage\/sessions\/[^/]+\/(end|heartbeat)$/.test(path)) payload = { ok: true };
  else if (path === '/api/settings') payload = {};
  else if (path === '/api/notifications/announcements') payload = { items: [], serverTime: Date.now() };
  else if (path === '/api/chats' || path === '/api/characters') payload = [];
  else if (path === '/api/auth-smoke/slow') return;
  else {
    status = 404;
    payload = { error: `No browser fixture for ${path}` };
  }
  void cdp.send('Fetch.fulfillRequest', {
    requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(payload)).toString('base64'),
  }, message.sessionId).catch((error) => {
    if (!/Invalid InterceptionId|Session.*closed|No session|Target closed/i.test(error.message)) errors.push(error.message);
  });
});

async function page(path = '/login') {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const result = { targetId, sessionId };
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${clientUrl}/api/*` }] }, sessionId);
  await cdp.send('Page.navigate', { url: `${clientUrl}${path}` }, sessionId);
  return result;
}

async function waitFor(check, label) {
  const end = Date.now() + 20000;
  let lastError;
  while (Date.now() < end) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await pause(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function store(page) {
  await waitFor(() => cdp.evaluate(page, `document.querySelector('#root')?.childElementCount > 0`), 'app mounted');
  await cdp.evaluate(page, `import('/src/stores/useAuthStore.ts').then(m => { window.authSmokeStore = m.useAuthStore; return true; })`);
}

async function snapshot(page) {
  return cdp.evaluate(page, `JSON.parse(localStorage.getItem('${authKey}'))`);
}

async function login(page, name) {
  await store(page);
  await cdp.evaluate(page, `window.authSmokeResult = null; window.authSmokeStore.getState().loginWithPassword('${users[name].phone}', 'fixture-password').then(() => { window.authSmokeResult = 'ok'; }, error => { window.authSmokeResult = error.name; }); true;`);
}

async function waitReady(page, name) {
  await waitFor(async () => {
    await store(page);
    return cdp.evaluate(page, `window.authSmokeStore.getState().user?.id === '${users[name].id}' && window.authSmokeStore.getState().isWorkspaceReady`);
  }, `${name} workspace ready`);
}

async function holdLock(owner) {
  await cdp.evaluate(owner, `window.authSmokeLocked = false; navigator.locks.request('${lockName}', () => new Promise(resolve => { window.authSmokeRelease = resolve; window.authSmokeLocked = true; })); true;`);
  await waitFor(() => cdp.evaluate(owner, 'window.authSmokeLocked'), 'browser lock acquired');
}

async function queuedLocks(owner, count) {
  await waitFor(() => cdp.evaluate(owner, `navigator.locks.query().then(s => s.pending.filter(x => x.name === '${lockName}').length >= ${count})`), `${count} queued authentication updates`);
}

try {
  const first = await page();
  await store(first);
  if (httpSmoke) {
    assert.deepEqual(await cdp.evaluate(first, `({ secure: isSecureContext, uuid: typeof crypto.randomUUID, locks: typeof navigator.locks })`),
      { secure: false, uuid: 'undefined', locks: 'undefined' });
    results.push('HTTP origin has no crypto.randomUUID or Web Locks');
  }
  // Exercise the actual React password login form before the concurrency cases.
  await waitFor(() => cdp.evaluate(first, `[...document.querySelectorAll('[role="tab"]')].some(x => x.textContent.includes('密码'))`), 'login tabs mounted');
  await cdp.evaluate(first, `[...document.querySelectorAll('[role="tab"]')].find(x => x.textContent.includes('密码')).click(); true;`);
  await waitFor(() => cdp.evaluate(first, `Boolean(document.querySelector('input[type="password"]'))`), 'password form');
  await cdp.evaluate(first, `(() => {
    const inputs = [...document.querySelectorAll('input')];
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const [input, value] of [[inputs.find(x => x.type !== 'password'), '${users.a.phone}'], [inputs.find(x => x.type === 'password'), 'fixture-password']]) {
      set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`);
  await cdp.evaluate(first, `[...document.querySelectorAll('button')].find(x => x.textContent.trim() === '登录').click(); true;`);
  await waitReady(first, 'a');
  results.push('password login through the React form');

  const second = await page();
  await waitReady(second, 'a');
  await cdp.send('Page.navigate', { url: `${clientUrl}/account` }, first.sessionId);
  await waitReady(first, 'a');
  await waitFor(() => cdp.evaluate(first, `[...document.querySelectorAll('button')].some(x => /^(退出登录|Log out)$/.test(x.textContent.trim()))`), 'account logout button');
  await cdp.evaluate(first, `[...document.querySelectorAll('button')].find(x => /^(退出登录|Log out)$/.test(x.textContent.trim())).click(); true;`);
  for (const tab of [first, second]) {
    await waitFor(() => cdp.evaluate(tab, `location.pathname === '/login' && Boolean(document.querySelector('input'))`), 'logout remains on login form');
  }
  await pause(2000);
  for (const tab of [first, second]) {
    assert.equal(await cdp.evaluate(tab, 'location.pathname'), '/login');
    assert.equal((await snapshot(tab)).token, null);
    await cdp.send('Page.reload', {}, tab.sessionId);
    await waitFor(() => cdp.evaluate(tab, `location.pathname === '/login' && Boolean(document.querySelector('input'))`), 'refresh keeps logged out');
  }
  results.push('account logout button keeps both active tabs logged out after waiting and refresh');
  await login(first, 'a');
  await waitReady(first, 'a');
  await waitReady(second, 'a');
  await cdp.evaluate(second, `(async () => {
    const life = await import('/src/services/workspaceLifecycle.ts');
    const reply = (await import('/src/services/replyOperation.ts')).createReplyOperation();
    const operation = reply.begin();
    const queue = await import('/src/services/chatCompletionQueue.ts');
    const input = { kind: 'text', chatId: 'fixture-chat', chatName: 'Smoke', field: 'topic', label: 'topic' };
    queue.enqueueChatCompletionTask({ ...input, run: () => new Promise(() => {}) });
    queue.enqueueChatCompletionTask({ ...input, run: async () => sessionStorage.setItem('auth-smoke-next-ran', 'yes') });
    life.onWorkspaceShutdown(() => sessionStorage.setItem('auth-smoke-stopped', JSON.stringify({
      signal: life.getWorkspaceSignal().aborted, reply: operation.controller.signal.aborted,
      queued: queue.getChatCompletionSummary().text.total
    })));
    return true;
  })()`);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }, second.sessionId);
  await cdp.evaluate(first, `window.authSmokeStore.getState().logout().catch(error => console.error(error)); true;`);
  await waitFor(async () => (await snapshot(first))?.token === null, 'shared logout snapshot');
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }, second.sessionId);
  await cdp.send('Page.bringToFront', {}, second.sessionId);
  await waitFor(() => cdp.evaluate(second, `location.pathname === '/login' && Boolean(sessionStorage.getItem('auth-smoke-stopped'))`), 'frozen tab retired and reloaded');
  assert.deepEqual(await cdp.evaluate(second, `JSON.parse(sessionStorage.getItem('auth-smoke-stopped'))`), { signal: true, reply: true, queued: 0 });
  assert.equal(await cdp.evaluate(second, `sessionStorage.getItem('auth-smoke-next-ran')`), null);
  results.push('frozen tab resumes, aborts reply, drops queued work and reloads to login');

  if (!httpSmoke) {
    const owner = await page('/favicon.svg');
    await waitFor(() => cdp.evaluate(owner, 'document.readyState === "complete"'), 'lock owner document');
    await holdLock(owner);
    await login(first, 'a');
    await login(second, 'b');
    await queuedLocks(owner, 2);
    await cdp.evaluate(owner, 'window.authSmokeRelease(); true;');
    await waitFor(async () => Boolean((await snapshot(owner))?.token), 'concurrent login winner');
    const winner = (await snapshot(owner)).user.id === users.a.id ? 'a' : 'b';
    const current = await snapshot(owner);
    assert.equal(current.token, `fixture-${winner}`);
    assert.equal(current.refreshToken, `refresh-${winner}`);
    await waitReady(first, winner);
    await waitReady(second, winner);
    results.push('two concurrent logins commit one coherent session and retire the stale writer');

    const next = winner === 'a' ? 'b' : 'a';
    await holdLock(owner);
    const logoutCount = requests.filter(x => x.path === '/api/auth/logout').length;
    await login(second, next);
    await queuedLocks(owner, 1);
    await cdp.evaluate(first, `window.authSmokeStore.getState().logout().catch(() => {}); true;`);
    await queuedLocks(owner, 2);
    await cdp.evaluate(owner, 'window.authSmokeRelease(); true;');
    await waitReady(second, next);
    await waitReady(first, next);
    assert.equal((await snapshot(owner)).token, `fixture-${next}`);
    assert.equal(requests.filter(x => x.path === '/api/auth/logout').length, logoutCount);
    results.push('a stale logout waiting for the lock cannot clear or revoke the new account');
  }

  await mkdir(reportDir, { recursive: true });
  for (const [name, tab] of [['first', first], ['second', second]]) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, tab.sessionId);
    await writeFile(resolve(reportDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
  }
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  assert.ok(pendingLogins >= (httpSmoke ? 2 : 4));
  const report = { ok: true, browser: version.Browser, mode: 'isolated Chrome context with fixture authentication APIs', results, reportDir };
  await writeFile(resolve(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, results, requests, errors, error: error.stack }, null, 2));
  process.exitCode = 1;
} finally {
  await cdp.send('Target.disposeBrowserContext', { browserContextId });
  cdp.close();
}
