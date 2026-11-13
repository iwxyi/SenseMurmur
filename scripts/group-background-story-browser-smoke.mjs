const CLIENT_URL = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5174';
const CDP_URL = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';

async function cdpFetch(path, init) {
  const response = await fetch(`${CDP_URL}${path}`, init);
  if (!response.ok) throw new Error(`CDP ${path} failed: ${response.status}`);
  return response.json();
}

class CdpClient {
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
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const pages = await cdpFetch('/json/list');
  const page = pages.find((item) => item.type === 'page');
  if (!page) throw new Error('No Chromium page is available');
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.open();
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `${CLIENT_URL}/chats` });
    await sleep(1200);
    const result = await cdp.evaluate(`(async () => {
      const [{ useChatStore }, { useMessageStore }, { normalizeConversation }, background, workflow] = await Promise.all([
        import('/src/stores/useChatStore.ts'),
        import('/src/stores/useMessageStore.ts'),
        import('/src/types/chat.ts'),
        import('/src/services/groupBackgroundConversation.ts'),
        import('/src/services/workflowRunRuntime.ts'),
      ]);
      const chatId = 'story-background-browser-smoke';
      const chat = normalizeConversation({
        id: chatId, type: 'group', name: '故事后台烟测', memberIds: [], createdAt: Date.now(), updatedAt: Date.now(), lastMessageAt: Date.now(),
        isActive: false,
        sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid' },
        scenarioState: { phase: 'choice', choiceEpoch: 1 },
      });
      useChatStore.setState((state) => ({ ...state, chats: [...state.chats.filter((item) => item.id !== chatId), chat] }));
      useMessageStore.setState((state) => ({ ...state, messages: [
        ...state.messages.filter((item) => item.chatId !== chatId),
        { id: 'story-choice-browser-smoke', chatId, type: 'ai', senderId: 'narrator', senderName: '旁白', content: '请选择剧情走向', emotion: 0, timestamp: Date.now(),
          metadata: { storyChoices: [{ label: '打开档案室' }, { label: '追问医生' }] } },
      ] }));
      await background.startGroupBackgroundConversation(chatId);
      const snapshot = (await background.listGroupBackgroundConversations(chatId))[0];
      const output = {
        status: snapshot?.tasks[0]?.status,
        output: snapshot?.tasks[0]?.output,
        choiceGate: background.isGroupBackgroundTurnBlocked(chat, useMessageStore.getState().messages.filter((item) => item.chatId === chatId)),
        active: useChatStore.getState().chats.find((item) => item.id === chatId)?.isActive,
      };
      useChatStore.setState((state) => ({ ...state, chats: state.chats.filter((item) => item.id !== chatId) }));
      useMessageStore.setState((state) => ({ ...state, messages: state.messages.filter((item) => item.chatId !== chatId) }));
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pneumata-workflow-runs', 6);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('runs', 'readwrite');
        tx.objectStore('runs').delete(workflow.currentWorkflowScope() + String.fromCharCode(10) + snapshot.run.id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return JSON.stringify(output);
    })()`);
    const parsed = JSON.parse(result);
    if (parsed.status !== 'completed' || parsed.output?.outcome !== 'stopped' || parsed.output?.reason !== 'waiting_story_choice'
      || parsed.choiceGate !== true || parsed.active !== false) {
      throw new Error(`Story background gate failed: ${JSON.stringify(parsed)}`);
    }
    console.log(JSON.stringify({ ok: true, browser: 'Chromium', ...parsed }, null, 2));
  } finally {
    cdp.ws.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
