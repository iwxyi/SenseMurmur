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
    if (result.exceptionDetails) throw new Error(result.result?.description || result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.ws.close(); }
}

const pages = await (await fetch(`${cdpUrl}/json/list`)).json();
const origin = new URL(clientUrl).origin;
const page = pages.find((item) => item.type === 'page' && item.url.startsWith(origin));
if (!page) throw new Error(`Open MirageTea in Chrome first: ${clientUrl}`);
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.open();

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `${clientUrl}/chats` });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await cdp.evaluate(`Boolean(document.querySelector('#root')?.childElementCount)`)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await cdp.evaluate(`(async () => {
    const [{ useChatStore }, { useMessageStore }, { useAssistantArtifactStore }, { useAuthStore },
      { createAgentTeamWorkflow }, { currentWorkflowScope, indexedDbWorkflowRepository }] = await Promise.all([
      import('/src/stores/useChatStore.ts'), import('/src/stores/useMessageStore.ts'),
      import('/src/stores/useAssistantArtifactStore.ts'), import('/src/stores/useAuthStore.ts'),
      import('/src/services/agentTeamWorkflow.ts'), import('/src/services/workflowRunRuntime.ts'),
    ]);
    localStorage.setItem('pneumata-auth-mode', 'local');
    localStorage.removeItem('pneumata-token');
    localStorage.removeItem('pneumata-user');
    localStorage.setItem('pneumata-cloud-sync-enabled', '0');
    useAuthStore.setState({ authMode: 'local', token: null, user: null, isLoggedIn: false, isLoading: false });
    await Promise.all([
      useChatStore.persist.hasHydrated() ? undefined : useChatStore.persist.rehydrate(),
      useMessageStore.persist.hasHydrated() ? undefined : useMessageStore.persist.rehydrate(),
      useAssistantArtifactStore.persist.hasHydrated() ? undefined : useAssistantArtifactStore.persist.rehydrate(),
    ]);
    window.__cleanupDeliveryFixture = async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pneumata-workflow-runs', 5);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const tx = database.transaction(['runs', 'events', 'outbox', 'outbox_consumers', 'task_attempts', 'plan_revisions'], 'readwrite');
        for (const idPrefix of ['browser-team-delivery-', 'stalled-']) {
          const prefix = currentWorkflowScope() + String.fromCharCode(10) + idPrefix;
          for (const name of tx.objectStoreNames) tx.objectStore(name).delete(IDBKeyRange.bound(prefix, prefix + String.fromCharCode(65535)));
        }
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      } finally { database.close(); }
    };
    await window.__cleanupDeliveryFixture();
    const now = Date.now();
    const runId = 'browser-team-delivery-' + crypto.randomUUID();
    const chatId = 'browser-team-chat-' + crypto.randomUUID();
    useChatStore.setState((state) => ({ chats: [...state.chats, {
      id: chatId, type: 'assistant', name: '浏览器闭环测试', memberIds: [], deletedAt: null,
      createdAt: now, updatedAt: now, lastMessageAt: now,
    }] }));
    const plan = {
      summary: '市场机会分析',
      roles: [{ id: 'analyst', name: '市场分析师', responsibility: '分析公开市场资料', method: '分别整理结论和数据', acceptance: '内容完整', allowedTools: ['text_generation'] }],
      tasks: [
        { id: 'report', roleId: 'analyst', goal: '撰写市场研究报告', dependsOn: [], acceptance: '报告完整', deliverable: { kind: 'document', title: '市场研究报告' } },
        { id: 'table', roleId: 'analyst', goal: '整理市场数据表', dependsOn: [], acceptance: '表格完整', deliverable: { kind: 'table', title: '市场数据表', language: 'markdown' } },
      ],
      finalAcceptance: '报告与数据表均完整',
    };
    const requests = [];
    let responseSequence = null;
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (!String(input).includes('mock-llm.invalid')) return originalFetch(input, init);
      const request = JSON.parse(init.body);
      requests.push(request);
      const content = responseSequence ? responseSequence.shift() : requests.length === 1 ? JSON.stringify(plan)
        : JSON.stringify(request.messages).includes('整理市场数据表')
          ? '| 类别 | 数量 |\\n| --- | ---: |\\n| A | 3 |'
          : '市场研究报告：需求稳定，主要机会集中在订阅服务。';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'browser-smoke', baseUrl: 'https://mock-llm.invalid/v1', model: 'smoke-model' }, currentWorkflowScope);
      const paused = await workflow.start(runId, chatId, '研究市场机会并交付报告和数据表', false, undefined, 2);
      if (paused.snapshot.run.status !== 'paused' || requests.length !== 2) throw new Error('调用额度未正确暂停任务');
      const recoveredWorkflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'browser-smoke', baseUrl: 'https://mock-llm.invalid/v1', model: 'smoke-model' }, currentWorkflowScope);
      const persisted = await recoveredWorkflow.read(runId);
      if (persisted.run.maxModelCalls !== 2) throw new Error('调用额度未持久化');
      await recoveredWorkflow.setModelCallLimit(runId, persisted.run.planVersion, 3);
      const completed = await recoveredWorkflow.resume(runId);
      if (completed.snapshot.run.status !== 'completed') throw new Error('真实 WorkflowRun 未完成：' + JSON.stringify(completed.snapshot));
      await workflow.publish(runId);
      const afterFirstDelivery = await indexedDbWorkflowRepository.read(currentWorkflowScope(), runId);
      const artifactStore = useAssistantArtifactStore.getState();
      const messageStore = useMessageStore.getState();
      const artifacts = artifactStore.getArtifactsForChat(chatId).filter((item) => item.sourceMessageId.startsWith('team-delivery-' + runId));
      const messages = [...messageStore.messages, ...(messageStore.messageWindowsByChatId[chatId]?.messages || [])]
        .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
        .filter((item) => item.id === 'team-delivery-' + runId);
      await workflow.publish(runId);
      const artifactsAfterRepeat = artifactStore.getArtifactsForChat(chatId).filter((item) => item.sourceMessageId.startsWith('team-delivery-' + runId));
      const messagesAfterRepeat = [...useMessageStore.getState().messages, ...(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages || [])]
        .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
        .filter((item) => item.id === 'team-delivery-' + runId);
      const deliveryModelCalls = requests.length;
      const stalledPlan = { ...plan, tasks: [plan.tasks[0]] };
      const verdict = JSON.stringify({ complete: false, reason: '缺少公开来源', nextRequest: '补充公开来源' });
      responseSequence = [JSON.stringify(stalledPlan), '目前没有来源', verdict, JSON.stringify(stalledPlan), '目前没有来源', verdict];
      const stalledRunId = 'stalled-' + crypto.randomUUID();
      const stalled = await workflow.start(stalledRunId, chatId, '研究市场且结论必须有来源', true);
      if (stalled.snapshot.run.status !== 'paused') throw new Error('重复返工未暂停');
      const block = stalled.snapshot.tasks.find((task) => task.id === 'review_needs_user');
      if (!block?.error?.includes('没有产生新的文本交付')) throw new Error('未说明无进展原因');
      if (requests.length !== deliveryModelCalls + 6) throw new Error('无进展后仍有额外模型调用');
      const restarted = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'browser-smoke', baseUrl: 'https://mock-llm.invalid/v1', model: 'smoke-model' }, currentWorkflowScope);
      await restarted.resume(stalledRunId);
      if (requests.length !== deliveryModelCalls + 6) throw new Error('重新打开后重复了无进展请求');
      window.fetch = originalFetch;
      return {
        status: afterFirstDelivery?.run.status,
        deliveryStatus: afterFirstDelivery?.run.deliveryStatus,
        taskStatuses: afterFirstDelivery?.tasks.map((task) => task.status),
        artifactKinds: artifacts.map((item) => item.kind).sort(),
        artifactsAfterRepeat: artifactsAfterRepeat.length,
        messages: messages.length,
        messagesAfterRepeat: messagesAfterRepeat.length,
        modelCalls: deliveryModelCalls,
        budgetRecovery: paused.snapshot.run.status === 'paused' && completed.snapshot.run.maxModelCalls === 3,
        stalledStatus: stalled.snapshot.run.status,
        stalledModelCalls: requests.length - deliveryModelCalls,
      };
    } finally { window.fetch = originalFetch; }
  })()`);
  assert.equal(result.status, 'completed');
  assert.equal(result.deliveryStatus, 'published');
  assert.deepEqual(result.taskStatuses, ['completed', 'completed', 'completed']);
  assert.deepEqual(result.artifactKinds, ['document', 'table']);
  assert.equal(result.artifactsAfterRepeat, 2);
  assert.equal(result.messages, 1);
  assert.equal(result.messagesAfterRepeat, 1);
  assert.equal(result.modelCalls, 3);
  assert.equal(result.budgetRecovery, true);
  assert.equal(result.stalledStatus, 'paused');
  assert.equal(result.stalledModelCalls, 6);
  console.log(JSON.stringify({ ok: true, ...result }));
} finally {
  await cdp.evaluate('window.__cleanupDeliveryFixture?.()').catch((error) => console.error('Fixture cleanup failed:', error));
  cdp.close();
}
