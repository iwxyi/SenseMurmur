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
    let result;
    try {
      result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    } catch (error) {
      if (!String(error?.message || error).includes('Promise was collected')) throw error;
      await sleep(350);
      result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    }
    if (result.exceptionDetails) throw new Error(result.result?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      if (!String(error?.message || error).includes('Promise was collected')) throw error;
    }
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}

const pages = await (await fetch(`${cdpUrl}/json/list`)).json();
const clientOrigin = new URL(clientUrl).origin;
const page = pages.find((item) => item.type === 'page' && item.url.startsWith(clientOrigin));
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
    const [{ useAuthStore }, { useChatStore }, { buildAssistantChatDraft }, { currentWorkflowScope, indexedDbWorkflowRepository }, { flushBufferedPersistenceWrites }] = await Promise.all([
      import('/src/stores/useAuthStore.ts'), import('/src/stores/useChatStore.ts'), import('/src/services/chatDraftBuilder.ts'), import('/src/services/workflowRunRuntime.ts'), import('/src/stores/storePersistenceScope.ts'),
    ]);
    localStorage.setItem('pneumata-auth-mode', 'local');
    localStorage.removeItem('pneumata-token');
    localStorage.removeItem('pneumata-user');
    localStorage.setItem('pneumata-cloud-sync-enabled', '0');
    useAuthStore.setState({ authMode: 'local', token: null, user: null, isLoggedIn: false, isLoading: false, isWorkspaceReady: true });
    if (!useChatStore.persist.hasHydrated()) await useChatStore.persist.rehydrate();
    const fixtureChatPrefix = 'home-resume-smoke-chat';
    const fixtureRunPrefix = 'home-resume-smoke-run';
    const fixtureDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pneumata-workflow-runs', 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = fixtureDb.transaction('runs', 'readwrite');
      const cursorRequest = tx.objectStore('runs').openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (String(cursor.key).includes(fixtureRunPrefix)) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    fixtureDb.close();
    const now = Date.now();
    const chat = { ...buildAssistantChatDraft(), id: fixtureChatPrefix, createdAt: now, updatedAt: now, lastMessageAt: now };
    useChatStore.setState({ chats: [...useChatStore.getState().chats.filter((item) => !item.id.startsWith(fixtureChatPrefix)), chat] });
    const runId = fixtureRunPrefix;
    await indexedDbWorkflowRepository.transact(currentWorkflowScope(), runId, () => ({ snapshot: {
      run: { id: runId, chatId: chat.id, goal: '仅验证首页恢复入口', status: 'paused', generation: 1, planVersion: 1, updatedAt: now },
      tasks: [{ id: runId + ':task', runId, kind: 'assistant_reply', input: { chatId: chat.id, userMessageId: 'synthetic-message', replyRunId: runId }, dependsOn: [], status: 'queued', attempt: 0, updatedAt: now }],
    }, value: undefined }));
    flushBufferedPersistenceWrites();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return runId;
  })()`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(() => cdp.evaluate(`Boolean(document.body?.innerText.includes('工作台概览'))`), 'home overview rendered');
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[aria-label^="恢复全部可继续任务"]'))`), 'resume button rendered');
  const layout = await cdp.evaluate(`(() => {
    const button = document.querySelector('[aria-label^="恢复全部可继续任务"]');
    const bounds = button.getBoundingClientRect();
    return { label: button.getAttribute('aria-label'), buttonWidth: bounds.width, viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth };
  })()`);
  assert.match(layout.label, /[1-9]\d* 个/);
  assert.ok(layout.buttonWidth > 0 && layout.buttonWidth < layout.viewportWidth);
  assert.equal(layout.pageWidth, layout.viewportWidth);
  await cdp.send('Page.navigate', { url: `${clientUrl}/settings?tab=chat` });
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('#settings-card-background-execution'))`), 'background execution settings rendered');
  const settings = await cdp.evaluate(`(() => {
    const card = document.querySelector('#settings-card-background-execution');
    return { title: card.innerText, selectCount: card.querySelectorAll('[role="combobox"]').length };
  })()`);
  assert.match(settings.title, /后台运行|Background execution/);
  assert.equal(settings.selectCount, 1);
  await cdp.evaluate(`document.querySelector('#settings-card-background-execution [role="combobox"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await waitFor(() => cdp.evaluate(`Boolean([...document.querySelectorAll('[role="option"]')].find((item) => item.innerText.includes('2 个会话')))`), 'concurrency options opened');
  await cdp.evaluate(`([...document.querySelectorAll('[role="option"]')].find((item) => item.innerText.includes('2 个会话')))?.click()`);
  await waitFor(() => cdp.evaluate(`(async () => (await import('/src/services/backgroundExecutionPreferences.ts')).getBackgroundExecutionPreferences().maxActiveConversations === 2)()`), 'concurrency preference saved');
  await cdp.send('Page.navigate', { url: `${clientUrl}/settings?tab=chat` });
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('#settings-card-background-execution'))`), 'settings restored after reload');
  const persistedConcurrency = await cdp.evaluate(`(async () => (await import('/src/services/backgroundExecutionPreferences.ts')).getBackgroundExecutionPreferences().maxActiveConversations)()`);
  assert.equal(persistedConcurrency, 2);
  await cdp.evaluate(`document.querySelector('#settings-card-background-execution [role="combobox"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await waitFor(() => cdp.evaluate(`Boolean([...document.querySelectorAll('[role="option"]')].find((item) => item.innerText.includes('3 个会话')))`), 'default concurrency option reopened');
  await cdp.evaluate(`([...document.querySelectorAll('[role="option"]')].find((item) => item.innerText.includes('3 个会话')))?.click()`);
  console.log(JSON.stringify({ ok: true, fixture: 'synthetic-only', layout, settings }, null, 2));
} finally {
  cdp.close();
}
