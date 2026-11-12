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
let cleanupSource;

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
      messageBranchState: { enabled: true, activeBranchName: 'main', activeLeafNodeId: 'source-node', refs: {
        main: { name: 'main', headNodeId: 'source-node', createdAt: now, updatedAt: now, version: 0 },
        alternate: { name: 'alternate', headNodeId: 'alternate-node', createdAt: now, updatedAt: now, version: 0 },
      } },
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
      const selectBranch = (name) => useChatStore.setState((state) => ({ chats: state.chats.map((chat) => chat.id === chatId
        ? { ...chat, messageBranchState: { ...chat.messageBranchState, activeBranchName: name,
          activeLeafNodeId: chat.messageBranchState.refs[name].headNodeId } } : chat) }));
      selectBranch('alternate');
      const branchPaused = await recoveredWorkflow.resume(runId);
      if (branchPaused.snapshot.run.status !== 'paused' || !branchPaused.snapshot.run.pauseReason?.includes('分支已切换') || requests.length !== 2) {
        throw new Error('切换分支后仍提交了模型请求');
      }
      selectBranch('main');
      const completed = await recoveredWorkflow.resume(runId);
      if (completed.snapshot.run.status !== 'completed') throw new Error('真实 WorkflowRun 未完成：' + JSON.stringify(completed.snapshot));
      await workflow.publish(runId);
      const deliveredChat = useChatStore.getState().chats.find((chat) => chat.id === chatId);
      if (deliveredChat.messageBranchState.refs.main.headNodeId !== 'team-delivery-' + runId
        || deliveredChat.messageBranchState.refs.alternate.headNodeId !== 'alternate-node') throw new Error('交付没有正确推进来源分支');
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
      const stalledModelCalls = requests.length - deliveryModelCalls;
      const interruptedRunId = 'browser-team-delivery-' + crypto.randomUUID();
      responseSequence = [JSON.stringify(plan), '中断后应恢复的报告', '| 类别 | 数量 |\\n| A | 3 |'];
      await workflow.start(interruptedRunId, chatId, '验证交付清单恢复');
      const applyDelivery = useAssistantArtifactStore.getState().applyWorkflowDelivery;
      useAssistantArtifactStore.setState({ applyWorkflowDelivery: () => { throw new Error('browser simulated shutdown after intent'); } });
      let interrupted = false;
      try { await workflow.publish(interruptedRunId); }
      catch (error) { if (!error.message.includes('simulated shutdown')) throw error; interrupted = true; }
      finally { useAssistantArtifactStore.setState({ applyWorkflowDelivery: applyDelivery }); }
      if (!interrupted) throw new Error('没有模拟到清单保存后的中断');
      const intent = (await workflow.read(interruptedRunId)).run.delivery;
      if (!intent || useAssistantArtifactStore.getState().items.some((item) => intent.artifacts.some((entry) => entry.after.id === item.id))) throw new Error('清单中断边界错误');
      const { workflowToolInvocationId, workflowToolOperationKey } = await import('/src/services/workflowToolInvocation.ts');
      const { describeWorkflowToolRequest } = await import('/src/services/workflowToolRequest.ts');
      const toolRunId = runId + '-tools';
      await indexedDbWorkflowRepository.transact(currentWorkflowScope(), toolRunId, () => ({ snapshot: {
        run: { id: toolRunId, chatId, goal: '工具重载恢复', status: 'paused', generation: 1, planVersion: 1, updatedAt: now },
        tasks: ['reserved', 'started', 'accepted'].map((state) => ({ id: state, runId: toolRunId, kind: 'agent_video',
          input: {}, dependsOn: [], status: 'running', attempt: 1, updatedAt: now,
          toolInvocation: { schemaVersion: 1, id: workflowToolInvocationId(toolRunId, state, 1), operationKey: workflowToolOperationKey(toolRunId, state),
            runId: toolRunId, taskId: state, kind: 'agent_video', attempt: 1, planVersion: 1,
            state: state === 'reserved' ? 'reserved' : 'started', reservedAt: now, ...(state === 'reserved' ? {} : {
              startedAt: now, request: describeWorkflowToolRequest('video_generation', { prompt: state + ' private input' }),
            }) } })),
      }, value: undefined }));
      window.fetch = originalFetch;
      return {
        runId, chatId, interruptedRunId, interruptedVersions: intent.artifacts.map((entry) => entry.after.currentVersionId),
        status: afterFirstDelivery?.run.status,
        deliveryStatus: afterFirstDelivery?.run.deliveryStatus,
        taskStatuses: afterFirstDelivery?.tasks.map((task) => task.status),
        artifactKinds: artifacts.map((item) => item.kind).sort(),
        artifactsAfterRepeat: artifactsAfterRepeat.length,
        messages: messages.length,
        messagesAfterRepeat: messagesAfterRepeat.length,
        modelCalls: deliveryModelCalls,
        budgetRecovery: paused.snapshot.run.status === 'paused' && completed.snapshot.run.maxModelCalls === 3,
        branchRecovery: branchPaused.snapshot.run.status === 'paused' && !completed.snapshot.run.pauseReason
          && messages[0]?.metadata?.branching?.parentNodeId === 'source-node',
        stalledStatus: stalled.snapshot.run.status,
        stalledModelCalls,
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
  assert.equal(result.branchRecovery, true);
  assert.equal(result.stalledStatus, 'paused');
  assert.equal(result.stalledModelCalls, 6);
  cleanupSource = await cdp.evaluate('window.__cleanupDeliveryFixture.toString()');
  await cdp.send('Page.reload');
  let reloaded = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    reloaded = await cdp.evaluate(`Boolean(document.querySelector('#root')?.childElementCount) && !window.__cleanupDeliveryFixture`);
    if (reloaded) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(reloaded, true, 'Browser did not reload');
  let automaticallyPublished = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    automaticallyPublished = await cdp.evaluate(`(async () => {
      const { currentWorkflowScope, indexedDbWorkflowRepository } = await import('/src/services/workflowRunRuntime.ts');
      return (await indexedDbWorkflowRepository.read(currentWorkflowScope(), ${JSON.stringify(result.interruptedRunId)}))?.run.deliveryStatus === 'published';
    })()`);
    if (automaticallyPublished) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(automaticallyPublished, true, 'Application startup did not restore pending delivery');
  const restored = await cdp.evaluate(`(async () => {
    const [{ useMessageStore }, { useAssistantArtifactStore }, { currentWorkflowScope, indexedDbWorkflowRepository, createWorkflowRunRuntime }, { createAgentTeamWorkflow }] = await Promise.all([
      import('/src/stores/useMessageStore.ts'), import('/src/stores/useAssistantArtifactStore.ts'), import('/src/services/workflowRunRuntime.ts'),
      import('/src/services/agentTeamWorkflow.ts'),
    ]);
    window.__cleanupDeliveryFixture = (${cleanupSource});
    await Promise.all([useMessageStore.persist.rehydrate(), useAssistantArtifactStore.persist.rehydrate()]);
    const chatId = ${JSON.stringify(result.chatId)};
    const runId = ${JSON.stringify(result.runId)};
    const toolRunId = runId + '-tools';
    const toolCalls = [];
    const { describeWorkflowToolRequest } = await import('/src/services/workflowToolRequest.ts');
    const toolRuntime = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
      tracksToolInvocations: true,
      execute: async (task, signal, context) => {
        await context.beginToolInvocation(describeWorkflowToolRequest('video_generation', { prompt: task.id + ' private input' }));
        toolCalls.push(task.id); return { output: '完成' };
      },
      reconcileInterrupted: async (task) => task.id === 'accepted' ? { status: 'waiting_external', externalTaskId: 'saved-provider-task' } : null,
      inspectExternal: async () => ({ status: 'completed', output: '已领取视频' }),
    }, currentWorkflowScope);
    const tools = await toolRuntime.resume(toolRunId);
    await toolRuntime.resume(toolRunId);
    if (toolCalls.join(',') !== 'reserved' || tools.tasks.map((task) => task.status).join(',') !== 'completed,result_unknown,completed'
      || tools.tasks.map((task) => task.toolInvocation.state).join(',') !== 'succeeded,result_unknown,succeeded') throw new Error('工具重载恢复重复提交或丢失调用记录');
    const toolAttempts = await indexedDbWorkflowRepository.listTaskAttempts(currentWorkflowScope(), toolRunId, 'reserved');
    if (toolAttempts.length !== 1 || toolAttempts[0].toolInvocation.state !== 'succeeded') throw new Error('工具恢复未保存执行历史');
    for (const task of tools.tasks) {
      const expected = describeWorkflowToolRequest('video_generation', { prompt: task.id + ' private input' });
      if (JSON.stringify(task.toolInvocation.request) !== JSON.stringify(expected)
        || JSON.stringify(task.toolInvocation).includes('private input')) throw new Error('工具请求摘要在刷新后丢失或泄露原文');
    }
    if (JSON.stringify(toolAttempts[0].toolInvocation.request) !== JSON.stringify(tools.tasks[0].toolInvocation.request)) throw new Error('任务历史与快照的请求摘要不一致');
    const interruptedRunId = ${JSON.stringify(result.interruptedRunId)};
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'browser-smoke', baseUrl: 'https://mock-llm.invalid/v1', model: 'smoke-model' }, currentWorkflowScope);
    await workflow.publish(interruptedRunId);
    await workflow.publish(interruptedRunId);
    const restoredIntent = (await workflow.read(interruptedRunId)).run.delivery;
    const interruptedVersions = restoredIntent.artifacts.map((entry) => entry.after.currentVersionId);
    if (JSON.stringify(interruptedVersions) !== JSON.stringify(${JSON.stringify(result.interruptedVersions)})) throw new Error('恢复替换了原清单版本');
    const snapshot = await indexedDbWorkflowRepository.read(currentWorkflowScope(), runId);
    const messages = [...useMessageStore.getState().messages, ...(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages || [])];
    const artifacts = useAssistantArtifactStore.getState().getArtifactsForChat(chatId).filter((item) => item.sourceMessageId.startsWith('team-delivery-' + runId));
    const resumedArtifacts = useAssistantArtifactStore.getState().getArtifactsForChat(chatId).filter((item) => item.sourceMessageId.startsWith('team-delivery-' + interruptedRunId));
    if (resumedArtifacts.length !== 2 || resumedArtifacts.some((item) => item.versions.length !== 1)) throw new Error('清单恢复重复或丢失产物');
    return { published: snapshot?.run.deliveryStatus === 'published',
      message: messages.some((item) => item.id === 'team-delivery-' + runId),
      artifacts: artifacts.length, versions: artifacts.map((item) => item.versions.length) };
  })()`);
  assert.deepEqual(restored, { published: true, message: true, artifacts: 2, versions: [1, 1] });
  delete result.runId;
  delete result.chatId;
  delete result.interruptedRunId;
  delete result.interruptedVersions;
  result.reloadRecovery = true;
  result.intentRecovery = true;
  result.toolReloadRecovery = true;
  console.log(JSON.stringify({ ok: true, ...result }));
} finally {
  await cdp.evaluate('window.__cleanupDeliveryFixture?.()').catch((error) => console.error('Fixture cleanup failed:', error));
  cdp.close();
}
