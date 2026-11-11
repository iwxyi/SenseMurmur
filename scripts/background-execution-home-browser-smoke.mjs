import assert from 'node:assert/strict';

const clientUrl = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5173';
const cdpUrl = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.nextId = 1; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data.toString());
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.result?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}

const pages = await (await fetch(`${cdpUrl}/json/list`)).json();
const page = pages.find((item) => item.type === 'page');
if (!page) throw new Error('Start Chrome with a page and remote debugging enabled');
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.open();

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.navigate', { url: clientUrl });
  await waitFor(() => cdp.evaluate(`document.querySelector('#root')?.childElementCount > 0`), 'app mounted');
  const fixture = await cdp.evaluate(`(async () => {
    const [{ useAuthStore }, { currentWorkflowScope, indexedDbWorkflowRepository }] = await Promise.all([
      import('/src/stores/useAuthStore.ts'), import('/src/services/workflowRunRuntime.ts'),
    ]);
    localStorage.setItem('pneumata-auth-mode', 'local');
    localStorage.removeItem('pneumata-token');
    localStorage.removeItem('pneumata-user');
    localStorage.setItem('pneumata-cloud-sync-enabled', '0');
    useAuthStore.setState({ authMode: 'local', token: null, user: null, isLoggedIn: false, isLoading: false, isWorkspaceReady: true });
    const runId = 'home-resume-smoke-' + crypto.randomUUID();
    const now = Date.now();
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'synthetic-chat', goal: '仅验证首页恢复入口', status: 'paused', generation: 1, planVersion: 1, updatedAt: now },
      tasks: [{ id: runId + ':task', runId, kind: 'assistant_reply', input: { chatId: 'synthetic-chat', userMessageId: 'synthetic-message', replyRunId: runId }, dependsOn: [], status: 'queued', attempt: 0, updatedAt: now }],
    }, value: undefined }));
    return runId;
  })()`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(() => cdp.evaluate(`document.body.innerText.includes('工作台概览')`), 'home overview rendered');
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[aria-label^="恢复全部可继续任务"]'))`), 'resume button rendered');
  const layout = await cdp.evaluate(`(() => {
    const button = document.querySelector('[aria-label^="恢复全部可继续任务"]');
    const bounds = button.getBoundingClientRect();
    return { label: button.getAttribute('aria-label'), buttonWidth: bounds.width, viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth };
  })()`);
  assert.match(layout.label, /1 个/);
  assert.ok(layout.buttonWidth > 0 && layout.buttonWidth < layout.viewportWidth);
  assert.equal(layout.pageWidth, layout.viewportWidth);
  console.log(JSON.stringify({ ok: true, fixture: 'synthetic-only', layout }, null, 2));
} finally {
  cdp.close();
}
