import assert from 'node:assert/strict';

const baseUrl = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5173';
const cdpUrl = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';
const target = await (await fetch(`${cdpUrl}/json/new?about:blank`, { method: 'PUT' })).json();
assert.ok(target.webSocketDebuggerUrl, 'Chrome must allow creating a test page');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 0;
let navigationCount = 0;
let taskQueries = 0;
let downloads = 0;
let generationSubmissions = 0;
let interceptionError;
const pending = new Map();
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
const task = { task_id: 'fixture-image-task', model: 'nano-banana-2:official', status: 'succeeded', result: {},
  chargedAmount: 1, reservedAmount: 1, createdAt: 1, updatedAt: 2 };

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data.toString());
  if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) navigationCount += 1;
  if (message.method === 'Fetch.requestPaused') {
    const { requestId, request } = message.params;
    const path = new URL(request.url).pathname;
    let body;
    let mime = 'application/json';
    if (path.endsWith('/ai/media/generations')) { generationSubmissions += 1; body = Buffer.from('{}'); }
    else if (path.endsWith('/ai/media/tasks/fixture-image-task')) { taskQueries += 1; body = Buffer.from(JSON.stringify(task)); }
    else if (path.endsWith('/media-assets/from-ai-task/fixture-image-task/content')) { downloads += 1; body = imageBytes; mime = 'image/png'; }
    else { void send('Fetch.continueRequest', { requestId }).catch((error) => { interceptionError = error; }); return; }
    void send('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: mime }], body: body.toString('base64') })
      .catch((error) => { interceptionError = error; });
  }
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  clearTimeout(item.timer);
  if (message.error) item.reject(new Error(message.error.message));
  else item.resolve(message.result);
});

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function waitFor(expression, label) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function navigate(method, params = {}) {
  const before = navigationCount;
  await send(method, params);
  const until = Date.now() + 20_000;
  while (navigationCount === before) {
    if (Date.now() > until) throw new Error('Page navigation timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await waitFor(`document.readyState === 'complete' && Boolean(document.querySelector('#root')?.childElementCount)`, 'app navigation');
}

const chatId = `browser-async-image-chat-${crypto.randomUUID()}`;
const messageId = `browser-async-image-message-${crypto.randomUUID()}`;
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await navigate('Page.navigate', { url: `${baseUrl}/chats` });
  const seeded = await evaluate(`(async () => {
    const [{ useChatStore }, { useMessageStore }, { buildAssistantChatDraft }, { commitBufferedPersistenceWrites },
      { getLocalDataUserId }, { scopedStorageKey }] = await Promise.all([
        import('/src/stores/useChatStore.ts'), import('/src/stores/useMessageStore.ts'),
        import('/src/services/chatDraftBuilder.ts'), import('/src/stores/storePersistenceScope.ts'),
        import('/src/services/authStorageScope.ts'), import('/src/constants/brand.ts'),
      ]);
    await Promise.all([useChatStore.persist.hasHydrated() ? undefined : useChatStore.persist.rehydrate(),
      useMessageStore.persist.hasHydrated() ? undefined : useMessageStore.persist.rehydrate()]);
    const chatId = ${JSON.stringify(chatId)};
    const messageId = ${JSON.stringify(messageId)};
    const now = Date.now();
    const chat = { ...buildAssistantChatDraft(), id: chatId, name: '异步图片恢复烟测', createdAt: now, updatedAt: now, lastMessageAt: now };
    const message = { id: messageId, chatId, type: 'ai', senderId: 'assistant', senderName: '助手', content: '图片',
      emotion: 0, timestamp: now, isDeleted: false, metadata: { attachments: [{ id: 'fixture-image', kind: 'image',
        status: 'generating', altText: '森林图片', promptText: '森林图片', executionQuoteId: 'fixture-approved-quote',
        generationJobId: 'fixture-request-key', mediaTaskId: 'fixture-image-task', createdAt: now, updatedAt: now }] } };
    useChatStore.setState((state) => ({ chats: [...state.chats, chat] }));
    useMessageStore.getState().upsertMessage(message);
    await commitBufferedPersistenceWrites([scopedStorageKey('chats-' + getLocalDataUserId()), scopedStorageKey('messages-' + getLocalDataUserId())]);
    return Boolean(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.some((item) => item.id === messageId));
  })()`);
  assert.equal(seeded, true, 'Fixture message was not cached');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*ai/media/*', requestStage: 'Request' },
    { urlPattern: '*media-assets/from-ai-task/*', requestStage: 'Request' }] });
  await navigate('Page.reload', { ignoreCache: true });
  await waitFor(`(async () => {
    const { useMessageStore } = await import('/src/stores/useMessageStore.ts');
    const message = useMessageStore.getState().messageWindowsByChatId[${JSON.stringify(chatId)}]?.messages.find((item) => item.id === ${JSON.stringify(messageId)});
    const attachment = message?.metadata?.attachments?.find((item) => item.id === 'fixture-image');
    return attachment?.status === 'ready' && attachment.url?.startsWith('data:image/png;base64,') && !attachment.mediaTaskId;
  })()`, 'saved image recovered after page reload');
  if (interceptionError) throw interceptionError;
  assert.ok(taskQueries >= 1, 'Saved task ID was not queried');
  assert.equal(downloads, 1, 'Generated image should be downloaded once');
  assert.equal(generationSubmissions, 0, 'Recovery must not generate or charge again');
  console.log('PASS: application reload resumes saved image task, downloads one image, and never submits generation; fixture backend responses');
} finally {
  try {
    await evaluate(`(async () => {
      const [{ useChatStore }, { useMessageStore }, { commitBufferedPersistenceWrites }, { getLocalDataUserId }, { scopedStorageKey }] = await Promise.all([
        import('/src/stores/useChatStore.ts'), import('/src/stores/useMessageStore.ts'), import('/src/stores/storePersistenceScope.ts'),
        import('/src/services/authStorageScope.ts'), import('/src/constants/brand.ts')]);
      useChatStore.setState((state) => ({ chats: state.chats.filter((item) => item.id !== ${JSON.stringify(chatId)}) }));
      useMessageStore.setState((state) => ({ messages: state.messages.filter((item) => item.id !== ${JSON.stringify(messageId)}),
        messageWindowsByChatId: Object.fromEntries(Object.entries(state.messageWindowsByChatId).filter(([id]) => id !== ${JSON.stringify(chatId)})) }));
      await commitBufferedPersistenceWrites([scopedStorageKey('chats-' + getLocalDataUserId()), scopedStorageKey('messages-' + getLocalDataUserId())]);
    })()`);
  } catch (error) { console.error('Fixture cleanup failed:', error); }
  for (const item of pending.values()) clearTimeout(item.timer);
  socket.close();
  await fetch(`${cdpUrl}/json/close/${target.id}`);
}
