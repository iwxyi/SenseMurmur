import assert from 'node:assert/strict';

const clientUrl = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5174';
const cdpUrl = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

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
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  close() { this.ws.close(); }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label) {
  const until = Date.now() + 20_000;
  let lastError;
  while (Date.now() < until) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await wait(150);
  }
  throw new Error(`Timed out: ${label}${lastError ? `: ${lastError.message}` : ''}`);
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
  await cdp.send('Page.navigate', { url: `${clientUrl}/chats` });
  await waitFor(() => cdp.evaluate(`document.querySelector('#root')?.childElementCount > 0`), 'app mounted');

  const fixture = await cdp.evaluate(`(async () => {
    const [{ useChatStore }, { useMessageStore }, { useAuthStore }, { buildAssistantChatDraft },
      { flushBufferedPersistenceWrites }, { currentWorkflowScope },
      { assistantReplyRunId }] = await Promise.all([
        import('/src/stores/useChatStore.ts'), import('/src/stores/useMessageStore.ts'),
        import('/src/stores/useAuthStore.ts'), import('/src/services/chatDraftBuilder.ts'),
        import('/src/stores/storePersistenceScope.ts'), import('/src/services/workflowRunRuntime.ts'),
        import('/src/services/assistantBackgroundReply.ts'),
      ]);
    localStorage.setItem('pneumata-auth-mode', 'local');
    localStorage.removeItem('pneumata-token');
    localStorage.removeItem('pneumata-user');
    localStorage.setItem('pneumata-cloud-sync-enabled', '0');
    useAuthStore.setState({ authMode: 'local', token: null, user: null, isLoggedIn: false, isLoading: false });
    await Promise.all([
      useChatStore.persist.hasHydrated() ? undefined : useChatStore.persist.rehydrate(),
      useMessageStore.persist.hasHydrated() ? undefined : useMessageStore.persist.rehydrate(),
    ]);
    const now = Date.now();
    const chatId = crypto.randomUUID();
    const chat = { ...buildAssistantChatDraft(), id: chatId, createdAt: now, updatedAt: now, lastMessageAt: now };
    const committedUserId = crypto.randomUUID();
    const unknownUserId = crypto.randomUUID();
    const committedRunId = assistantReplyRunId(chatId, committedUserId);
    const unknownRunId = assistantReplyRunId(chatId, unknownUserId);
    const message = (id, type, content, timestamp, metadata) => ({
      id, chatId, type, senderId: type === 'user' ? 'user' : 'assistant',
      senderName: type === 'user' ? '用户' : '助手', content, emotion: 0, timestamp,
      isDeleted: false, ...(metadata ? { metadata } : {}),
    });
    const messages = [
      message(committedUserId, 'user', '已完成请求', now),
      message(crypto.randomUUID(), 'ai', '已保存的回复', now + 1,
        { assistantReplyToUserMessageId: committedUserId, assistantReplyRunId: committedRunId }),
      message(unknownUserId, 'user', '中断请求', now + 2),
    ];
    useChatStore.setState({ chats: [chat], currentChatId: chatId, isLoading: false });
    useMessageStore.setState({ activeChatId: chatId, messages, messageWindowsByChatId: {
      [chatId]: { messages, lastSyncedAt: now, updatedAt: now + 2, remoteExhausted: true, activeLimit: 80 },
    }, isLoading: false });
    const scope = currentWorkflowScope();
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pneumata-workflow-runs', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const [runId, userMessageId] of [[committedRunId, committedUserId], [unknownRunId, unknownUserId]]) {
      const transaction = database.transaction('runs', 'readwrite');
      transaction.objectStore('runs').put({
        run: { id: runId, chatId, goal: '回复用户消息', status: 'active', generation: 1, planVersion: 1, updatedAt: now },
        tasks: [{ id: userMessageId, runId, kind: 'assistant_reply',
          input: { chatId, userMessageId, replyRunId: runId }, dependsOn: [], status: 'running', attempt: 1, updatedAt: now }],
      }, scope + '\\n' + runId);
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }
    database.close();
    flushBufferedPersistenceWrites();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return { chatId, committedRunId, unknownRunId };
  })()`);

  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(() => cdp.evaluate(`document.querySelector('#root')?.childElementCount > 0`), 'app remounted');
  await waitFor(async () => {
    const result = await cdp.evaluate(`(async () => {
      const { listAssistantBackgroundReplies } = await import('/src/services/assistantBackgroundReply.ts');
      return (await listAssistantBackgroundReplies(${JSON.stringify(fixture.chatId)})).map((item) => ({
        id: item.run.id, schemaVersion: item.schemaVersion, status: item.run.status, taskStatus: item.tasks[0]?.status,
      }));
    })()`);
    return result.find((item) => item.id === fixture.committedRunId)?.status === 'completed'
      && result.find((item) => item.id === fixture.unknownRunId)?.taskStatus === 'result_unknown';
  }, 'assistant runs recovered after reload');

  const result = await cdp.evaluate(`(async () => {
    const { listAssistantBackgroundReplies } = await import('/src/services/assistantBackgroundReply.ts');
    return (await listAssistantBackgroundReplies(${JSON.stringify(fixture.chatId)})).map((item) => ({
      id: item.run.id, schemaVersion: item.schemaVersion, status: item.run.status, taskStatus: item.tasks[0]?.status,
    }));
  })()`);
  assert.equal(result.find((item) => item.id === fixture.committedRunId)?.taskStatus, 'completed');
  assert.equal(result.find((item) => item.id === fixture.unknownRunId)?.status, 'paused');
  assert.equal(result.find((item) => item.id === fixture.committedRunId)?.schemaVersion, 1);
  assert.equal(result.find((item) => item.id === fixture.unknownRunId)?.schemaVersion, 1);
  console.log(JSON.stringify({ ok: true, result }, null, 2));
} finally {
  cdp.close();
}
