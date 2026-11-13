import assert from 'node:assert/strict';

const clientUrl = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5173';
const cdpUrl = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.nextId = 1; this.pending = new Map(); this.errors = []; }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
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
    await wait(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

const pages = await (await fetch(`${cdpUrl}/json/list`)).json();
const page = pages.find((item) => item.type === 'page');
if (!page) throw new Error('Start Chrome with a page and remote debugging enabled');
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.open();

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `${clientUrl}/chats` });
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('#root')?.childElementCount)`), 'app mounted');
  await cdp.evaluate(`(async () => {
    const mainSource = await (await fetch('/src/main.tsx')).text();
    const dependencyUrl = (name) => {
      const path = mainSource.split('"').find((part) => part.startsWith('/node_modules/.vite/deps/' + name + '.js?'));
      if (!path) throw new Error('Cannot resolve Vite dependency: ' + name);
      return path;
    };
    const [reactModule, reactDomClient, { default: Workbench }] = await Promise.all([
      import(dependencyUrl('react')), import(dependencyUrl('react-dom_client')),
      import('/src/components/chat/AssistantTeamWorkbench.tsx'),
    ]);
    const React = reactModule.default || reactModule;
    const createRoot = reactDomClient.createRoot || reactDomClient.default?.createRoot;
    const now = Date.now();
    const runId = 'browser-collab-' + crypto.randomUUID();
    const plan = { summary: '市场研究', roles: [{ id: 'analyst', name: '市场分析师', responsibility: '分析市场竞争', method: '比较公开资料', acceptance: '结论注明来源', allowedTools: ['text_generation'] }], tasks: [{ id: 'research', roleId: 'analyst', goal: '研究市场竞争', dependsOn: [], acceptance: '结论注明来源', tool: 'text_generation' }], finalAcceptance: '结论可复核' };
    const run = { run: { id: runId, chatId: 'browser-collab-chat', goal: '研究市场机会', status: 'completed', generation: 1, planVersion: 2, updatedAt: now }, tasks: [
      { id: 'plan', runId, kind: 'team_plan', input: '研究市场机会', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
      { id: 'research', runId, kind: 'agent_text', input: { task: plan.tasks[0], role: plan.roles[0], goal: '研究市场机会' }, output: '主要竞争者采用订阅模式', dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: now },
    ] };
    const { createWorkflowRunRuntime, indexedDbWorkflowRepository, currentWorkflowScope, WorkflowPreflightError } = await import('/src/services/workflowRunRuntime.ts');
    const { defaultWorkflowGoalSpec } = await import('/src/services/workflowGoalSpec.ts');
    const { generateResponse, generateJsonResponse, generateImage } = await import('/src/services/aiClient.ts');
    const originalBudgetBoundaryFetch = window.fetch;
    let directBudgetRequests = 0;
    window.fetch = async () => { directBudgetRequests++; throw new Error('Budgeted direct request escaped'); };
    try {
      const directConfig = { provider: 'openai', apiKey: '', baseUrl: 'https://example.test/v1', model: 'fixture' };
      const aiUsage = { type: 'assistant_chat', workflow: { schemaVersion: 1, runId: 'budget-boundary',
        taskId: 'direct', attempt: 1, kind: 'model', budgetRevision: 1 } };
      for (const call of [() => generateResponse(directConfig, 'test', [], undefined, { aiUsage }),
        () => generateJsonResponse(directConfig, 'test', [], { aiUsage }),
        () => generateImage(directConfig, { prompt: 'test', aiUsage })]) {
        let rejected = false;
        try { await call(); } catch (error) {
          rejected = error.code === 'WORKFLOW_BUDGET_CHANNEL_UNSUPPORTED' && error.status === 409;
        }
        if (!rejected) throw new Error('Budgeted direct request did not preserve a repairable rejection');
      }
      if (directBudgetRequests !== 0) throw new Error('Budgeted direct request accessed the network');
    } finally { window.fetch = originalBudgetBoundaryFetch; }
    window.__cleanupCollaborationFixture = async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pneumata-workflow-runs', 6);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const tx = database.transaction(['runs', 'events', 'outbox', 'outbox_consumers', 'task_attempts', 'plan_revisions'], 'readwrite');
        const prefix = currentWorkflowScope() + String.fromCharCode(10) + 'browser-collab-';
        for (const name of tx.objectStoreNames) tx.objectStore(name).delete(IDBKeyRange.bound(prefix, prefix + String.fromCharCode(65535)));
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      } finally { database.close(); }
    };
    await window.__cleanupCollaborationFixture();
    const { recoverAgentTeamRuns } = await import('/src/services/agentTeamWorkflow.ts');
    const { useChatStore: outboxChats } = await import('/src/stores/useChatStore.ts');
    const { useAssistantArtifactStore: outboxArtifacts } = await import('/src/stores/useAssistantArtifactStore.ts');
    const { useMessageStore: outboxMessages } = await import('/src/stores/useMessageStore.ts');
    if (!outboxChats.persist.hasHydrated()) await outboxChats.persist.rehydrate();
    const outboxRunId = 'browser-collab-outbox-' + crypto.randomUUID();
    const outboxChatId = outboxRunId + '-chat';
    const outboxScope = currentWorkflowScope();
    outboxChats.setState((state) => ({ chats: [...state.chats, { id: outboxChatId, type: 'assistant',
      name: '交付回执恢复验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null }] }));
    await indexedDbWorkflowRepository.transact(outboxScope, outboxRunId, () => ({ snapshot: {
      ...run, run: { ...run.run, id: outboxRunId, chatId: outboxChatId, status: 'paused' },
      tasks: run.tasks.map((task) => ({ ...task, runId: outboxRunId })),
    }, value: undefined }));
    const originalOutboxList = indexedDbWorkflowRepository.listOutboxEvents;
    const originalOutboxAck = indexedDbWorkflowRepository.acknowledgeOutboxEvents;
    let completedAfterScan = false;
    let receiptInterrupted = false;
    indexedDbWorkflowRepository.listOutboxEvents = async (...args) => {
      const events = await originalOutboxList(...args);
      if (args[1] === outboxRunId && !completedAfterScan) {
        completedAfterScan = true;
        await indexedDbWorkflowRepository.transact(outboxScope, outboxRunId, (current) => ({
          snapshot: { ...current, run: { ...current.run, status: 'completed' } }, value: undefined,
        }));
      }
      return events;
    };
    indexedDbWorkflowRepository.acknowledgeOutboxEvents = async (...args) => {
      if (args[1] === outboxRunId && !receiptInterrupted) {
        receiptInterrupted = true;
        throw new Error('确定性交付回执中断');
      }
      return originalOutboxAck(...args);
    };
    try {
      await recoverAgentTeamRuns();
      if (!receiptInterrupted || (await indexedDbWorkflowRepository.read(outboxScope, outboxRunId)).run.deliveryStatus !== 'published'
        || !(await originalOutboxList(outboxScope, outboxRunId, 'team-delivery')).length) throw new Error('Delivery was skipped or receipt acknowledged before publication');
    } finally {
      indexedDbWorkflowRepository.listOutboxEvents = originalOutboxList;
      indexedDbWorkflowRepository.acknowledgeOutboxEvents = originalOutboxAck;
    }
    await recoverAgentTeamRuns();
    if ((await originalOutboxList(outboxScope, outboxRunId, 'team-delivery')).length
      || outboxArtifacts.getState().getArtifactsForChat(outboxChatId).length !== 1
      || outboxMessages.getState().messageWindowsByChatId[outboxChatId]?.messages.filter((message) => message.id === 'team-delivery-' + outboxRunId).length !== 1) throw new Error('Outbox replay duplicated delivery or lost receipt');
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
      execute: async () => ({ output: '主要竞争者采用订阅模式' }),
    }, currentWorkflowScope);
    await runtime.create({ ...run, run: { ...run.run, status: 'active' }, tasks: run.tasks.map((task) => task.id === 'research' ? { ...task, status: 'queued', attempt: 0, output: undefined } : task) });
    const persistedRun = await runtime.resume(runId);
    const admissionId = 'browser-collab-admission-' + crypto.randomUUID();
    let budgetAllowed = false;
    let admissionRequests = 0;
    const admissionVersions = [];
    const admissionExecutor = { tracksModelInvocations: true, execute: async (_task, _signal, context) => {
      admissionVersions.push((await context.beginModelInvocation()).budgetRevision);
      admissionRequests++;
      if (!budgetAllowed) throw Object.assign(new Error('private diagnostic'), {
        diagnostic: { status: 409, code: 'WORKFLOW_BUDGET_REVISION_CONFLICT' },
      });
      return { output: '预算恢复后的交付' };
    } };
    const admissionRuntime = createWorkflowRunRuntime(indexedDbWorkflowRepository, admissionExecutor, currentWorkflowScope);
    await admissionRuntime.create({ run: { ...run.run, id: admissionId, status: 'paused', goalSpec: defaultWorkflowGoalSpec(run.run.goal) }, tasks: [{
      id: 'admission', runId: admissionId, kind: 'agent_text', input: '生成报告', dependsOn: [], status: 'queued', attempt: 0, updatedAt: now,
    }] });
    await admissionRuntime.bindPlatformBudget(admissionId, run.run.planVersion, { revision: 1, billingUnit: 'point', limitAmount: '2.000000' });
    const admissionPaused = await admissionRuntime.resume(admissionId);
    if (admissionPaused.run.status !== 'paused' || admissionPaused.tasks[0].status !== 'queued'
      || admissionPaused.tasks[0].modelInvocation.state !== 'rejected' || admissionRequests !== 1
      || admissionPaused.run.pauseReason.includes('private')) throw new Error('Budget rejection was not safely paused');
    const rejectedAttempts = await indexedDbWorkflowRepository.listTaskAttempts(currentWorkflowScope(), admissionId, 'admission');
    if (rejectedAttempts[0]?.status !== 'failed') throw new Error('Rejected attempt was not persisted');
    budgetAllowed = true;
    const admissionRestored = createWorkflowRunRuntime(indexedDbWorkflowRepository, admissionExecutor, currentWorkflowScope);
    await admissionRestored.bindPlatformBudget(admissionId, admissionPaused.run.planVersion, { revision: 2, billingUnit: 'point', limitAmount: '3.000000' });
    const admissionDone = await admissionRestored.resume(admissionId);
    if (admissionDone.run.status !== 'completed' || admissionRequests !== 2
      || JSON.stringify(admissionVersions) !== '[1,2]'
      || admissionDone.run.goalSpec.platformBudget.revision !== 2
      || JSON.stringify((await indexedDbWorkflowRepository.listTaskAttempts(currentWorkflowScope(), admissionId, 'admission'))[0]) !== JSON.stringify(rejectedAttempts[0])) {
      throw new Error('Budget resume lost the rejected attempt or repeated a request');
    }
    const capabilityRunId = 'browser-collab-capability-' + crypto.randomUUID();
    let capabilityRepaired = false;
    let capabilityExecutions = 0;
    let capabilityRequests = 0;
    const capabilityExecutor = { tracksModelInvocations: true, execute: async (_task, _signal, context) => {
      capabilityExecutions += 1;
      if (!capabilityRepaired) throw new WorkflowPreflightError('未配置视频模型', { tool: 'video_generation', code: 'model_missing' });
      await context.beginModelInvocation();
      capabilityRequests += 1;
      return { output: '修复配置后的交付' };
    } };
    const capabilityRuntime = createWorkflowRunRuntime(indexedDbWorkflowRepository, capabilityExecutor, currentWorkflowScope);
    await capabilityRuntime.create({ ...run, run: { ...run.run, id: capabilityRunId, status: 'active' }, tasks: run.tasks.map((task) => ({
      ...task, runId: capabilityRunId,
      ...(task.id === 'plan' ? { output: { ...plan, summary: '能力恢复验证' } } : { status: 'queued', attempt: 0, output: undefined }),
    })) });
    await capabilityRuntime.resume(capabilityRunId);
    const capabilityRestored = createWorkflowRunRuntime(indexedDbWorkflowRepository, capabilityExecutor, currentWorkflowScope);
    const capabilityRun = await capabilityRestored.read(capabilityRunId);
    if (capabilityRun.tasks[1].capabilityIssue?.code !== 'model_missing' || capabilityRequests !== 0) throw new Error('Capability failure was not persisted before request');
    await capabilityRestored.resume(capabilityRunId);
    if (capabilityExecutions !== 1) throw new Error('Capability failure automatically repeated');
    const retryCapability = async (item, task) => {
      capabilityRepaired = true;
      const retry = await capabilityRestored.retryFailedTeamTask(item.run.id, item.run.planVersion, task.id);
      if (retry.tasks[1].capabilityIssue) throw new Error('Old capability issue survived retry');
      const completed = await capabilityRestored.resume(item.run.id);
      await createWorkflowRunRuntime(indexedDbWorkflowRepository, capabilityExecutor, currentWorkflowScope).resume(item.run.id);
      if (completed.run.status !== 'completed' || capabilityExecutions !== 2 || capabilityRequests !== 1
        || JSON.stringify(completed.tasks[0]) !== JSON.stringify(capabilityRun.tasks[0])) throw new Error('Capability repair repeated upstream work');
      window.__assistantTeamSmoke.capabilityRecovery = true;
    };
    const toolRunId = 'browser-collab-tool-' + crypto.randomUUID();
    const toolRuntime = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
      tracksToolInvocations: true,
      execute: async (_task, _signal, context) => { await context.beginToolInvocation(); return { output: '来源已查找' }; },
    }, currentWorkflowScope);
    await toolRuntime.create({ run: { ...run.run, id: toolRunId, status: 'active' }, tasks: [
      { ...run.tasks[1], runId: toolRunId, kind: 'agent_web_search', status: 'queued', attempt: 0, dependsOn: [] },
    ] });
    const toolRun = await toolRuntime.resume(toolRunId);
    const [{ createAgentTeamWorkflow }, { useChatStore }] = await Promise.all([
      import('/src/services/agentTeamWorkflow.ts'), import('/src/stores/useChatStore.ts'),
    ]);
    if (!useChatStore.persist.hasHydrated()) await useChatStore.persist.rehydrate();
    const recursiveId = 'browser-collab-recursive-' + crypto.randomUUID();
    const recursiveChatId = recursiveId + '-chat';
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: recursiveChatId, type: 'assistant', name: '递归委派验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null }] }));
    const originalFetch = window.fetch;
    let recursiveRequests = 0;
    const recursivePlan = (id, goal, tool) => JSON.stringify({ summary: goal,
      roles: [{ id: 'lead', name: '研究负责人', responsibility: '调研', method: '分解验证', acceptance: '有依据', allowedTools: tool === 'delegate_task' ? ['delegate_task', 'text_generation'] : ['text_generation'] }],
      tasks: [{ id, roleId: 'lead', goal, tool, dependsOn: [], acceptance: '有依据' }], finalAcceptance: '可用报告',
      delegationChecks: [{ taskId: id, status: 'narrower', reason: '仅研究市场证据，不承担整体机会报告' }] });
    const replies = [recursivePlan('research', '研究机会', 'delegate_task'), recursivePlan('market', '分析市场', 'delegate_task'),
      recursivePlan('evidence', '整理资料', 'text_generation'), '证据：离线使用需求', '市场交付：优先离线', '研究交付：离线方案'];
    const config = { provider: 'openai', baseUrl: 'https://delegation-smoke.invalid/v1', apiKey: 'test-fixture', model: 'fixture' };
    const initialBudgetConfig = { ...config, provider: 'official-ace', baseUrl: '/api/ai', apiKey: '' };
    const { api: initialBudgetApi } = await import('/src/services/api.ts');
    const originalInitialBudgetSave = initialBudgetApi.configureWorkflowBudget;
    const initialBudgetId = 'browser-collab-initial-budget-' + crypto.randomUUID();
    let initialPlanningRequests = 0;
    let rejectInitialSave;
    let initialSaveStarted = false;
    initialBudgetApi.configureWorkflowBudget = async () => {
      initialSaveStarted = true;
      return new Promise((_resolve, reject) => { rejectInitialSave = reject; });
    };
    window.fetch = async (input, init) => {
      if (new URL(String(input), location.origin).pathname !== '/api/ai/v1/chat/completions') return originalFetch(input, init);
      initialPlanningRequests++;
      return Response.json({ choices: [{ message: { role: 'assistant', content: recursivePlan('report', '研究市场', 'text_generation') }, finish_reason: 'stop' }] });
    };
    try {
      const initialWorkflow = createAgentTeamWorkflow(initialBudgetConfig, currentWorkflowScope);
      const starting = initialWorkflow.start(initialBudgetId, recursiveChatId, '研究市场', false,
        new AbortController().signal, 1, undefined, { limitAmount: '20', billingUnit: 'point' });
      const settled = starting.then(() => false, () => true);
      for (let tries = 0; !initialSaveStarted && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!initialSaveStarted) throw new Error('Initial budget save never started');
      const pending = await initialWorkflow.read(initialBudgetId);
      if (pending.run.status !== 'paused' || !pending.run.goalSpec.requirePlatformBudget
        || pending.tasks[0].attempt !== 0 || initialPlanningRequests !== 0) throw new Error('Planning bypassed the initial budget save');
      rejectInitialSave(new Error('预算保存失败'));
      if (!await settled) throw new Error('Initial budget save failure was hidden');
      const restored = createAgentTeamWorkflow(initialBudgetConfig, currentWorkflowScope);
      const blocked = (await restored.resume(initialBudgetId)).snapshot;
      if (blocked.run.status !== 'paused' || !blocked.run.pauseReason.includes('先保存平台任务预算')
        || blocked.tasks[0].attempt !== 0 || initialPlanningRequests !== 0) throw new Error('Restored planning bypassed missing budget');
      initialBudgetApi.configureWorkflowBudget = async (runId) => ({ schemaVersion: 1, runId, revision: 1,
        billingUnit: 'point', limitAmount: '20.000000', committedAmount: '0.000000', reservedAmount: '0.000000',
        remainingAmount: '20.000000', exceeded: false, unresolvedRequests: 0, updatedAt: Date.now() });
      await restored.setPlatformBudget(initialBudgetId, blocked.run.planVersion,
        { limitAmount: '20', billingUnit: 'point', expectedRevision: 0 });
      const planned = (await restored.resume(initialBudgetId)).snapshot;
      if (initialPlanningRequests !== 1 || planned.tasks[0].status !== 'completed'
        || planned.run.goalSpec.platformBudget.revision !== 1) throw new Error('Budget repair failed to release first planning');
      await createAgentTeamWorkflow(initialBudgetConfig, currentWorkflowScope).resume(initialBudgetId);
      if (initialPlanningRequests !== 1) throw new Error('Budget recovery duplicated first planning');
    } finally {
      initialBudgetApi.configureWorkflowBudget = originalInitialBudgetSave;
      window.fetch = originalFetch;
    }
    let recursiveRun;
    window.fetch = async (input, init) => {
      if (!String(input).startsWith('https://delegation-smoke.invalid/')) return originalFetch(input, init);
      const request = JSON.parse(init.body);
      if (recursiveRequests === 4 && !JSON.stringify(request.messages).includes('离线使用需求')) throw new Error('Missing child evidence');
      const content = replies[recursiveRequests++];
      if (!content) throw new Error('Unexpected duplicate model request');
      return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    };
    try {
      const workflow = createAgentTeamWorkflow(config, currentWorkflowScope);
      const paused = await workflow.start(recursiveId, recursiveChatId, '调研产品', false, new AbortController().signal, 3);
      if (paused.snapshot.run.status !== 'paused' || recursiveRequests !== 3
        || paused.snapshot.tasks.filter((task) => task.expansion).length !== 2) throw new Error('Delegation budget did not pause expanded children');
      const restored = createAgentTeamWorkflow(config, currentWorkflowScope);
      const saved = await restored.read(recursiveId);
      if (!saved.tasks.find((task) => task.id === 'research').expansion.context.delegationReview?.basisSha256) throw new Error('Missing durable delegation scope review');
      await restored.setModelCallLimit(recursiveId, saved.run.planVersion, 6);
      recursiveRun = (await restored.resume(recursiveId)).snapshot;
      if (recursiveRun.run.status !== 'completed' || recursiveRequests !== 6
        || recursiveRun.tasks.find((task) => task.id === 'research').output !== '研究交付：离线方案') throw new Error('Nested recovery or parent synthesis failed');
      await createAgentTeamWorkflow(config, currentWorkflowScope).resume(recursiveId);
      if (recursiveRequests !== 6) throw new Error('Recovery duplicated model requests');
      const attempts = await indexedDbWorkflowRepository.listTaskAttempts(currentWorkflowScope(), recursiveId, 'research');
      if (attempts.length !== 2 || attempts.some((attempt) => attempt.status !== 'completed')) throw new Error('Delegation attempt journal incomplete');
      const blockedId = recursiveId + '-semantic-loop';
      const blockedReplies = [recursivePlan('research', '研究产品市场机会', 'delegate_task'), JSON.stringify({
        ...JSON.parse(recursivePlan('again', '全面分析产品的市场发展潜力', 'delegate_task')),
        delegationChecks: [{ taskId: 'again', status: 'repeated', reason: '只换了措辞，仍负责同一完整目标' }],
      })];
      let blockedRequests = 0;
      window.fetch = async (input, init) => {
        if (!String(input).startsWith('https://delegation-smoke.invalid/')) return originalFetch(input, init);
        if (blockedRequests === 1 && !JSON.parse(init.body).messages.some((message) => String(message.content).includes('delegationChecks'))) throw new Error('Missing semantic scope instructions');
        const content = blockedReplies[blockedRequests++];
        if (!content) throw new Error('Semantic loop dispatched extra work');
        return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      };
      const blocked = (await createAgentTeamWorkflow(config, currentWorkflowScope).start(blockedId, recursiveChatId, '研究市场', false)).snapshot;
      if (blocked.run.status !== 'failed' || blocked.tasks.length !== 2
        || !blocked.tasks.find((task) => task.id === 'research').error.includes('范围无法确认')) throw new Error('Semantic loop was expanded');
      const reloaded = createAgentTeamWorkflow(config, currentWorkflowScope);
      await reloaded.resume(blockedId);
      if (blockedRequests !== 2 || (await reloaded.read(blockedId)).tasks.length !== 2) throw new Error('Semantic failure was not durable');
    } finally {
      window.fetch = originalFetch;
      useChatStore.setState((state) => ({ chats: state.chats.filter((chat) => chat.id !== recursiveChatId) }));
    }
    const patchId = 'browser-collab-patch-' + crypto.randomUUID();
    const patchChatId = patchId + '-chat';
    const { workflowJsonDigest } = await import('/src/services/workflowToolRequest.ts');
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: patchChatId, type: 'assistant', name: '局部重做验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null }] }));
    const patchPlan = { ...plan, tasks: [
      { ...plan.tasks[0], id: 'source', goal: '资料整理' },
      { ...plan.tasks[0], id: 'draft', goal: '草稿撰写', dependsOn: ['source'] },
      { ...plan.tasks[0], id: 'other', goal: '独立数据' },
      { ...plan.tasks[0], id: 'final', goal: '报告汇总', dependsOn: ['draft', 'other'] },
    ] };
    let patchRequests = 0;
    let patchResponse;
    let secondPatchResponse;
    window.fetch = async (input, init) => {
      if (!String(input).startsWith('https://delegation-smoke.invalid/')) return originalFetch(input, init);
      const request = JSON.parse(init.body);
      const index = patchRequests++;
      if (index === 5 && !request.messages.some((message) => String(message.content).includes('revisionPatch'))) throw new Error('Missing revision patch protocol');
      if (index === 7 && (!JSON.stringify(request.messages).includes('修改后的草稿') || !JSON.stringify(request.messages).includes('原始交付正文'))) throw new Error('Revision lost pinned or new evidence');
      if (index === 9 && !JSON.stringify(request.messages).includes('修改后的草稿')) throw new Error('Second revision lost actual previous draft');
      if (index > 9) throw new Error('Revision repeated completed work');
      const content = index === 0 ? JSON.stringify(patchPlan) : index === 5 ? patchResponse : index === 6 ? '修改后的草稿' : index === 7 ? '修改后的汇总'
        : index === 8 ? secondPatchResponse : index === 9 ? '第二轮汇总' : '原始交付正文';
      return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    };
    try {
      const workflow = createAgentTeamWorkflow(config, currentWorkflowScope);
      const first = (await workflow.start(patchId, patchChatId, '撰写报告', false, new AbortController().signal, 7)).snapshot;
      if (first.run.status !== 'completed' || patchRequests !== 5) throw new Error('Base revision fixture failed');
      const originalTasks = JSON.stringify(first.tasks.filter((task) => task.id !== 'plan'));
      patchResponse = JSON.stringify({ revisionPatch: { schemaVersion: 1, basePlanSha256: workflowJsonDigest(first.tasks.find((task) => task.id === 'plan').output),
        updates: [{ taskId: 'draft', goal: '通俗解释资料', acceptance: '易于理解' }] } });
      await workflow.addRevisionRequest(patchId, first.run.planVersion, '草稿改为通俗解释', 'draft');
      const paused = (await workflow.resume(patchId)).snapshot;
      const compilation = paused.tasks.find((task) => task.id === 'delegate').output.revisionCompilation;
      if (paused.run.status !== 'paused' || patchRequests !== 7 || JSON.stringify(compilation.rerunTaskIds) !== JSON.stringify(['draft', 'final'])
        || JSON.stringify(compilation.reusedTaskIds) !== JSON.stringify(['source', 'other'])
        || JSON.stringify(paused.tasks.filter((task) => ['source', 'draft', 'other', 'final'].includes(task.id))) !== originalTasks) throw new Error('Revision reissued unchanged work');
      const restored = createAgentTeamWorkflow(config, currentWorkflowScope);
      const checkpoint = await restored.read(patchId);
      if (!checkpoint.tasks.find((task) => task.id === 'delegate').output.revisionCompilation.basePlanSha256) throw new Error('Compilation not persisted');
      await restored.setModelCallLimit(patchId, checkpoint.run.planVersion, 8);
      if ((await restored.resume(patchId)).snapshot.run.status !== 'completed' || patchRequests !== 8) throw new Error('Partial revision recovery failed');
      await createAgentTeamWorkflow(config, currentWorkflowScope).resume(patchId);
      if (patchRequests !== 8) throw new Error('Repeated revision recovery duplicated requests');
      const firstRevision = await restored.read(patchId);
      secondPatchResponse = JSON.stringify({ revisionPatch: { schemaVersion: 1,
        basePlanSha256: workflowJsonDigest(firstRevision.tasks.find((task) => task.id === 'delegate').output),
        updates: [{ taskId: 'final', goal: '用简洁语气汇总', acceptance: '简洁完整' }] } });
      const secondRequest = await restored.addRevisionRequest(patchId, firstRevision.run.planVersion, '只修改最新汇总的语气', 'delegated_final');
      await restored.setModelCallLimit(patchId, secondRequest.run.planVersion, 9);
      const secondPause = (await restored.resume(patchId)).snapshot;
      const compiled = secondPause.tasks.find((task) => task.id === 'delegate_2').output;
      if (secondPause.run.status !== 'paused' || patchRequests !== 9 || compiled.tasks.length !== 1
        || !compiled.tasks[0].savedText.some((entry) => entry.alias === 'draft' && entry.taskId === 'delegated_draft')) throw new Error('Second revision did not pin actual task source');
      const secondRestored = createAgentTeamWorkflow(config, currentWorkflowScope);
      await secondRestored.setModelCallLimit(patchId, secondPause.run.planVersion, 10);
      if ((await secondRestored.resume(patchId)).snapshot.run.status !== 'completed' || patchRequests !== 10) throw new Error('Second revision recovery failed');
      await createAgentTeamWorkflow(config, currentWorkflowScope).resume(patchId);
      if (patchRequests !== 10) throw new Error('Repeated second revision duplicated work');
    } finally {
      window.fetch = originalFetch;
      useChatStore.setState((state) => ({ chats: state.chats.filter((chat) => chat.id !== patchChatId) }));
    }
    const reviewRunId = 'browser-collab-review-evidence-' + crypto.randomUUID();
    const reviewChatId = reviewRunId + '-chat';
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: reviewChatId, type: 'assistant', name: '审核依据验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null }] }));
    const reviewBody = '研究正文。'.repeat(500);
    let reviewRequests = 0;
    let reviewedEvidence;
    window.fetch = async (input, init) => {
      if (!String(input).startsWith('https://delegation-smoke.invalid/')) return originalFetch(input, init);
      const request = JSON.parse(init.body);
      const index = reviewRequests++;
      if (index === 2) {
        const content = request.messages.at(-1).content;
        reviewedEvidence = JSON.parse(content.split('项已完成记录未列出）：')[1].split('\\n')[0]);
        const entry = reviewedEvidence[0];
        if (entry.goal !== plan.tasks[0].goal || entry.acceptance !== plan.tasks[0].acceptance
          || entry.kind !== 'agent_text' || entry.output !== reviewBody.slice(0, 1800)
          || entry.outputCharacters !== reviewBody.length || entry.truncated !== true
          || !request.messages.some((message) => String(message.content).includes('未展示的部分不能当作已读取'))) throw new Error('Review lost task criteria or concealed truncation');
      }
      const content = [JSON.stringify(plan), reviewBody, JSON.stringify({ complete: true, reason: '确定性审核结果，仅验证链路' })][index];
      if (!content) throw new Error('Review evidence recovery duplicated model requests');
      return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    };
    try {
      const finished = await createAgentTeamWorkflow(config, currentWorkflowScope).start(reviewRunId, reviewChatId, '研究市场', true);
      const savedReview = finished.snapshot.tasks.find((task) => task.id === 'review_1').output;
      const { workflowJsonDigest } = await import('/src/services/workflowToolRequest.ts');
      if (finished.snapshot.run.status !== 'completed' || !reviewedEvidence || savedReview?.evidenceSha256 !== workflowJsonDigest(reviewedEvidence)) throw new Error('Review evidence was not durably bound: ' + JSON.stringify({ status: finished.snapshot.run.status, requests: reviewRequests, expected: reviewedEvidence && workflowJsonDigest(reviewedEvidence), actual: savedReview?.evidenceSha256, failures: finished.snapshot.tasks.filter((task) => task.error).map((task) => ({ kind: task.kind, error: task.error })) }));
      const restored = await createAgentTeamWorkflow(config, currentWorkflowScope).resume(reviewRunId);
      if (reviewRequests !== 3 || JSON.stringify(restored.snapshot.tasks.find((task) => task.id === 'review_1').output) !== JSON.stringify(savedReview)) throw new Error('Review record changed after recovery');
    } finally {
      window.fetch = originalFetch;
      useChatStore.setState((state) => ({ chats: state.chats.filter((chat) => chat.id !== reviewChatId) }));
    }
    const batchRunId = 'browser-collab-batch-review-' + crypto.randomUUID();
    const batchChatId = batchRunId + '-chat';
    const batchSpecs = Array.from({ length: 40 }, (_, index) => ({ ...plan.tasks[0], id: 'note_' + index,
      goal: '任务目标'.repeat(250), acceptance: '验收条件'.repeat(100) }));
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: batchChatId, type: 'assistant', name: '分批审核恢复验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null }] }));
    await runtime.create({ run: { ...run.run, id: batchRunId, chatId: batchChatId, status: 'active', planOpen: true, autoReview: true, maxModelCalls: 43 }, tasks: [
      { ...run.tasks[0], runId: batchRunId, output: { ...plan, tasks: batchSpecs } },
      ...batchSpecs.map((task) => ({ id: task.id, runId: batchRunId, kind: 'agent_text', input: { task, role: plan.roles[0], goal: '完整报告' },
        output: ('完整正文' + task.id).repeat(500), dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: now })),
    ] });
    const batchSeen = new Set();
    const batchRequests = new Set();
    let batchCalls = 0;
    const { TEAM_REVIEW_EVIDENCE_LIMIT, teamReviewLeafSources } = await import('/src/services/agentTeamReviewEvidence.ts');
    window.fetch = async (input, init) => {
      if (!String(input).startsWith('https://delegation-smoke.invalid/')) return originalFetch(input, init);
      const request = JSON.parse(init.body);
      const evidence = JSON.parse(request.messages.at(-1).content.split('项已完成记录未列出）：')[1].split('\\n')[0]);
      const key = evidence.map((entry) => entry.task).join(',');
      if (batchRequests.has(key)) throw new Error('Completed batch reviewed twice');
      batchRequests.add(key); batchCalls++;
      if (JSON.stringify(evidence).length > TEAM_REVIEW_EVIDENCE_LIMIT) throw new Error('Review evidence exceeded context limit');
      for (const entry of evidence) if (entry.kind === 'agent_text') batchSeen.add(entry.task);
      return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ complete: true, reason: '确定性分批审核，仅验证链路' }) }, finish_reason: 'stop' }] });
    };
    try {
      const paused = await createAgentTeamWorkflow(config, currentWorkflowScope).resume(batchRunId);
      if (paused.snapshot.run.status !== 'paused' || batchCalls !== 2) throw new Error('Batch review failed to persist at budget boundary');
      const doneBefore = paused.snapshot.tasks.filter((task) => task.kind === 'team_review' && task.status === 'completed');
      const restored = createAgentTeamWorkflow(config, currentWorkflowScope);
      const saved = await restored.read(batchRunId);
      await restored.setModelCallLimit(batchRunId, saved.run.planVersion);
      const finished = (await restored.resume(batchRunId)).snapshot;
      const root = finished.tasks.find((task) => task.id === 'review_1');
      if (finished.run.status !== 'completed' || !root.output.complete || batchSeen.size !== 40
        || teamReviewLeafSources(finished, root).length !== 40
        || doneBefore.some((task) => JSON.stringify(task.output) !== JSON.stringify(finished.tasks.find((item) => item.id === task.id).output))) throw new Error('Batch review recovery omitted or changed evidence');
      const calls = batchCalls;
      await createAgentTeamWorkflow(config, currentWorkflowScope).resume(batchRunId);
      if (batchCalls !== calls) throw new Error('Completed review was repeated after restart');
    } finally {
      window.fetch = originalFetch;
      useChatStore.setState((state) => ({ chats: state.chats.filter((chat) => chat.id !== batchChatId) }));
    }
    const textRunId = 'browser-collab-saved-text-' + crypto.randomUUID();
    const textChatId = textRunId + '-chat';
    const originalText = '逐字保留：' + '完整研究正文。'.repeat(400) + '末尾结论必须保留';
    const textTask = { ...plan.tasks[0], deliverable: { kind: 'document', title: '完整研究报告' } };
    const textPlan = { ...plan, tasks: [textTask] };
    const textSnapshot = { ...run, run: { ...run.run, id: textRunId, chatId: textChatId, autoReview: false },
      tasks: run.tasks.map((task) => ({ ...task, runId: textRunId, ...(task.id === 'plan' ? { output: textPlan }
        : { output: originalText, input: { ...task.input, task: textTask } }) })) };
    await runtime.create(textSnapshot);
    const { listTeamSavedText } = await import('/src/services/agentTeamSavedText.ts');
    const savedText = listTeamSavedText(textSnapshot, ['research']).map((entry) => ({ ...entry, alias: 'original_report' }));
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: textChatId, type: 'assistant', name: '历史正文验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null }] }));
    let savedTextRequests = 0;
    let artifactReference;
    let projectReferences;
    const editedText = '用户修订：' + originalText;
    window.fetch = async (input, init) => {
      if (!String(input).startsWith('https://delegation-smoke.invalid/')) return originalFetch(input, init);
      const request = JSON.parse(init.body);
      let content;
      if (savedTextRequests === 0) {
        if (!JSON.stringify(request.messages).includes(savedText[0].outputSha256)) throw new Error('Missing exact text version catalog');
        content = JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], id: 'followup', dependsOn: [], savedText }] });
      } else if (savedTextRequests === 1) {
        if (!JSON.stringify(request.messages).includes(originalText)) throw new Error('Saved text was truncated to a summary');
        content = '已根据完整研究正文完成后续交付';
      } else if (savedTextRequests === 2) {
        if (!JSON.stringify(request.messages).includes(artifactReference.artifact.versionId)) throw new Error('Missing edited artifact version catalog');
        content = JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], id: 'edited_followup', dependsOn: [], savedText: [artifactReference] }] });
      } else if (savedTextRequests === 3) {
        const messages = JSON.stringify(request.messages);
        if (!messages.includes(editedText) || messages.includes('不应自动切换的新版本')) throw new Error('Pinned artifact version was replaced or truncated');
        content = '已根据指定用户版本继续分析';
      } else if (savedTextRequests === 4) {
        if (!projectReferences.every((entry) => JSON.stringify(request.messages).includes(entry.artifact.filePath))) throw new Error('Project file catalog missing');
        content = JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], id: 'project_followup', dependsOn: [], savedText: projectReferences }] });
      } else if (savedTextRequests === 5) {
        const messages = JSON.stringify(request.messages);
        if (!messages.includes('PINNED_MAIN_FILE') || !messages.includes('PINNED_STYLE_FILE') || messages.includes('NEW_PROJECT_FILE')) throw new Error('Project file version was changed or omitted');
        content = '已读取两个指定版本文件';
      } else throw new Error('Saved text recovery repeated a model request');
      savedTextRequests++;
      return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    };
    try {
      await createAgentTeamWorkflow(config, currentWorkflowScope).addRevisionRequest(textRunId, 2, '使用原报告全文继续分析');
      const restoredText = createAgentTeamWorkflow(config, currentWorkflowScope);
      const done = (await restoredText.resume(textRunId)).snapshot;
      await createAgentTeamWorkflow(config, currentWorkflowScope).resume(textRunId);
      if (done.run.status !== 'completed' || savedTextRequests !== 2
        || done.tasks.find((task) => task.id === 'research').attempt !== 1
        || done.tasks.find((task) => task.id === 'research').output !== originalText) throw new Error('Exact saved text recovery failed');
      const beforeRevision = await indexedDbWorkflowRepository.listPlanRevisions(currentWorkflowScope(), textRunId);
      const beforeAttempts = await indexedDbWorkflowRepository.listTaskAttempts(currentWorkflowScope(), textRunId, 'research');
      let rejectedMutation = false;
      try {
        await indexedDbWorkflowRepository.transact(currentWorkflowScope(), textRunId, (current) => {
          current.tasks.find((task) => task.id === 'research').output = '覆盖旧稿';
          current.run.planVersion++;
          return { snapshot: current, value: undefined };
        });
      } catch (error) { rejectedMutation = error.message.includes('已完成的任务记录不可修改'); }
      if (!rejectedMutation || JSON.stringify(await restoredText.read(textRunId)) !== JSON.stringify(done)
        || JSON.stringify(await indexedDbWorkflowRepository.listPlanRevisions(currentWorkflowScope(), textRunId)) !== JSON.stringify(beforeRevision)
        || JSON.stringify(await indexedDbWorkflowRepository.listTaskAttempts(currentWorkflowScope(), textRunId, 'research')) !== JSON.stringify(beforeAttempts)) {
        throw new Error('Completed source evidence mutation did not roll back atomically');
      }
      const { useAssistantArtifactStore } = await import('/src/stores/useAssistantArtifactStore.ts');
      const artifact = await restoredText.publish(textRunId);
      const edit = (baseVersionId, search, replacement) => {
        const result = useAssistantArtifactStore.getState().applyTextOperations({ chatId: textChatId, operations: [
          { artifactId: artifact.id, baseVersionId, search, replacement },
        ] });
        if (result.results[0]?.error || result.results[0]?.replacements !== 1) throw new Error('Artifact edit failed');
        return result.artifacts[0];
      };
      const edited = edit(artifact.currentVersionId, originalText, editedText);
      const catalog = listTeamSavedText(done, ['research'], useAssistantArtifactStore.getState().items);
      artifactReference = { ...catalog.find((entry) => entry.artifact?.id === artifact.id), alias: 'edited_report' };
      if (!artifactReference.artifact) throw new Error('Edited artifact missing from catalog');
      const reopened = await restoredText.addRevisionRequest(textRunId, done.run.planVersion, '使用用户修改后的报告继续分析');
      await restoredText.setModelCallLimit(textRunId, reopened.run.planVersion, 5);
      const paused = (await restoredText.resume(textRunId)).snapshot;
      if (paused.run.status !== 'paused' || savedTextRequests !== 3) throw new Error('Artifact planning did not persist before budget pause');
      const newer = edit(edited.currentVersionId, editedText, '不应自动切换的新版本');
      const { commitBufferedPersistenceWrites } = await import('/src/stores/storePersistenceScope.ts');
      await commitBufferedPersistenceWrites();
      await useAssistantArtifactStore.persist.rehydrate();
      const restoredArtifact = createAgentTeamWorkflow(config, currentWorkflowScope);
      await restoredArtifact.setModelCallLimit(textRunId, paused.run.planVersion, 7);
      const final = (await restoredArtifact.resume(textRunId)).snapshot;
      await createAgentTeamWorkflow(config, currentWorkflowScope).resume(textRunId);
      if (final.run.status !== 'completed' || savedTextRequests !== 4
        || final.tasks.find((task) => task.id === 'research').output !== originalText
        || useAssistantArtifactStore.getState().items.find((item) => item.id === artifact.id)?.currentVersionId !== newer.currentVersionId) {
        throw new Error('Artifact version recovery changed source evidence, user edits or request count');
      }
      const projectId = artifact.id + '-project';
      const projectVersion = { id: projectId + '-v1', artifactId: projectId, content: '',
        sourceMessageId: artifact.sourceMessageId, createdAt: now, files: [
          { id: 'main', path: 'src/main.ts', content: 'PINNED_MAIN_FILE' },
          { id: 'style', path: 'src/style.css', content: 'PINNED_STYLE_FILE' },
        ] };
      useAssistantArtifactStore.setState((state) => ({ items: [...state.items, { ...artifact, id: projectId,
        currentVersionId: projectVersion.id, versions: [projectVersion] }] }));
      projectReferences = listTeamSavedText(final, ['research'], useAssistantArtifactStore.getState().items)
        .filter((entry) => entry.artifact?.id === projectId).map((entry, index) => ({ ...entry, alias: 'file_' + index }));
      if (projectReferences.length !== 2) throw new Error('Project files were not separately cataloged');
      const projectRevision = await restoredArtifact.addRevisionRequest(textRunId, final.run.planVersion, '使用两个项目文件继续工作');
      await restoredArtifact.setModelCallLimit(textRunId, projectRevision.run.planVersion, 7);
      const projectPaused = (await restoredArtifact.resume(textRunId)).snapshot;
      if (projectPaused.run.status !== 'paused' || savedTextRequests !== 5) throw new Error('Project file plan did not pause');
      useAssistantArtifactStore.setState((state) => ({ items: state.items.map((item) => item.id !== projectId ? item : {
        ...item, currentVersionId: projectId + '-v2', versions: [...item.versions, { ...projectVersion, id: projectId + '-v2',
          files: [{ id: 'main', path: 'src/main.ts', content: 'NEW_PROJECT_FILE' }] }],
      }) }));
      await commitBufferedPersistenceWrites();
      await useAssistantArtifactStore.persist.rehydrate();
      const projectRestored = createAgentTeamWorkflow(config, currentWorkflowScope);
      await projectRestored.setModelCallLimit(textRunId, projectPaused.run.planVersion);
      const projectDone = (await projectRestored.resume(textRunId)).snapshot;
      await createAgentTeamWorkflow(config, currentWorkflowScope).resume(textRunId);
      if (projectDone.run.status !== 'completed' || savedTextRequests !== 6) throw new Error('Project file recovery failed or repeated requests');
    } finally {
      window.fetch = originalFetch;
      useChatStore.setState((state) => ({ chats: state.chats.filter((chat) => chat.id !== textChatId) }));
    }
    const outputRunId = 'browser-collab-output-' + crypto.randomUUID();
    const outputChatId = outputRunId + '-chat';
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: outputChatId, type: 'assistant', name: 'JSON交付验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null }] }));
    const outputPlan = { ...plan, summary: 'JSON交付验证', tasks: [
      { ...plan.tasks[0], id: 'source', goal: '整理原始证据' },
      { ...plan.tasks[0], id: 'data', goal: '结构化数据', dependsOn: ['source'], deliverable: { schemaVersion: 1, kind: 'json', title: '数据',
        jsonSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } } },
      { ...plan.tasks[0], id: 'report', goal: '根据数据写报告', dependsOn: ['data'] },
    ] };
    let outputRequests = 0;
    const outputReplies = [JSON.stringify(outputPlan), '原始证据必须保留', '{"value":"1"}', '{"value":1}', '数据报告已完成'];
    const outputFetch = async (input, init) => {
      if (!String(input).startsWith('https://delegation-smoke.invalid/')) return originalFetch(input, init);
      const content = outputReplies[outputRequests++];
      if (!content) throw new Error('Unexpected output contract model request');
      return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    };
    let outputRun;
    window.fetch = outputFetch;
    try {
      outputRun = (await createAgentTeamWorkflow(config, currentWorkflowScope).start(outputRunId, outputChatId, 'JSON交付验证')).snapshot;
      if (outputRun.run.status !== 'failed' || outputRequests !== 3
        || !outputRun.tasks.find((task) => task.id === 'data').error.includes('JSON 不符合已声明的字段契约')
        || outputRun.tasks.find((task) => task.id === 'report').attempt !== 0) throw new Error('Invalid JSON reached downstream');
      await createAgentTeamWorkflow(config, currentWorkflowScope).resume(outputRunId);
      if (outputRequests !== 3) throw new Error('Invalid JSON was automatically retried');
    } finally { window.fetch = originalFetch; }
    const retryOutput = async (selected, task) => {
      window.fetch = outputFetch;
      try {
        const restored = createAgentTeamWorkflow(config, currentWorkflowScope);
        await restored.retryFailedTask(selected.run.id, task.id, selected.run.planVersion);
        const done = (await restored.resume(selected.run.id)).snapshot;
        await createAgentTeamWorkflow(config, currentWorkflowScope).resume(selected.run.id);
        const attempts = await indexedDbWorkflowRepository.listTaskAttempts(currentWorkflowScope(), selected.run.id, task.id);
        if (done.run.status !== 'completed' || outputRequests !== 5
          || done.tasks.find((item) => item.id === 'source').attempt !== 1
          || done.tasks.find((item) => item.id === 'data').output !== '{"value":1}'
          || attempts.map((item) => item.status).join(',') !== 'failed,completed') throw new Error('Output retry lost history or repeated upstream');
        window.__assistantTeamSmoke.outputRetry = true;
      } finally {
        window.fetch = originalFetch;
        useChatStore.setState((state) => ({ chats: state.chats.filter((chat) => chat.id !== outputChatId) }));
      }
    };
    const journalRunId = 'browser-collab-journal-' + crypto.randomUUID();
    await runtime.create({ ...run, run: { ...run.run, id: journalRunId, status: 'paused' },
      tasks: run.tasks.map((task) => ({ ...task, runId: journalRunId })) });
    await runtime.setModelCallLimit(journalRunId, 2, 12);
    const revisions = await indexedDbWorkflowRepository.listPlanRevisions(currentWorkflowScope(), journalRunId);
    if (revisions.length !== 1 || revisions[0].parentVersion !== 2 || revisions[0].version !== 3
      || revisions[0].changedRunFields.join(',') !== 'maxModelCalls') throw new Error('Plan revision was not persisted');
    const isolated = await indexedDbWorkflowRepository.listPlanRevisions(currentWorkflowScope() + '-other-user', journalRunId);
    if (isolated.length) throw new Error('Plan revision leaked across accounts');
    let rejectedJump = false;
    try {
      await indexedDbWorkflowRepository.transact(currentWorkflowScope(), journalRunId, (current) => ({
        snapshot: { ...current, run: { ...current.run, planVersion: 5 } }, value: undefined,
      }));
    } catch (error) { rejectedJump = error.message.includes('按版本顺序'); }
    if (!rejectedJump || (await runtime.read(journalRunId)).run.planVersion !== 3
      || (await indexedDbWorkflowRepository.listPlanRevisions(currentWorkflowScope(), journalRunId)).length !== 1) {
      throw new Error('Invalid plan revision did not roll back atomically');
    }
    const deadlineId = 'browser-collab-deadline-' + crypto.randomUUID();
    let deadlineCalls = 0;
    const deadlineRuntime = createWorkflowRunRuntime(indexedDbWorkflowRepository, { execute: async () => { deadlineCalls += 1; return { output: '已完成' }; } }, currentWorkflowScope);
    await deadlineRuntime.create({ run: { ...run.run, id: deadlineId, status: 'active', planVersion: 1,
      goalSpec: { ...defaultWorkflowGoalSpec(run.run.goal), preferences: ['优先已有素材'], deadlineAt: now - 1 } },
      tasks: [{ ...run.tasks[1], runId: deadlineId, dependsOn: [], status: 'queued', attempt: 0, output: undefined }] });
    const deadlinePaused = await deadlineRuntime.resume(deadlineId);
    if (deadlinePaused.run.status !== 'paused' || deadlineCalls !== 0) throw new Error('Expired deadline dispatched work');
    await deadlineRuntime.setDeadline(deadlineId, 1);
    const deadlineDone = await deadlineRuntime.resume(deadlineId);
    if (deadlineDone.run.status !== 'completed' || deadlineCalls !== 1
      || deadlineDone.run.goalSpec.preferences[0] !== '优先已有素材') throw new Error('Deadline recovery lost work or preferences');
    const conflictId = 'browser-collab-conflict-' + crypto.randomUUID();
    const conflictChatId = conflictId + '-chat';
    const [{ useAssistantArtifactStore }, { useMessageStore }, { commitBufferedPersistenceWrites }] = await Promise.all([
      import('/src/stores/useAssistantArtifactStore.ts'), import('/src/stores/useMessageStore.ts'), import('/src/stores/storePersistenceScope.ts'),
    ]);
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: conflictChatId, type: 'assistant', name: '交付冲突验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null,
      messageBranchState: { enabled: true, activeBranchName: 'main', activeLeafNodeId: null, refs: { main: { name: 'main', headNodeId: null, createdAt: now, updatedAt: now, version: 0 } } } }] }));
    const conflictGoalSpec = { ...defaultWorkflowGoalSpec(run.run.goal), sourceBranch: { enabled: true, name: 'main', headNodeId: null } };
    await runtime.create({ ...persistedRun, run: { ...persistedRun.run, id: conflictId, chatId: conflictChatId, goalSpec: conflictGoalSpec },
      tasks: persistedRun.tasks.map((task) => ({ ...task, runId: conflictId,
        ...(task.id === 'plan' ? { output: { ...plan, summary: '交付冲突验证' } } : {}) })) });
    const conflictWorkflow = createAgentTeamWorkflow(config, currentWorkflowScope);
    const applyDelivery = useAssistantArtifactStore.getState().applyWorkflowDelivery;
    useAssistantArtifactStore.setState({ applyWorkflowDelivery: () => { throw new Error('Simulated artifact save interruption'); } });
    try { await conflictWorkflow.publish(conflictId); throw new Error('Expected save interruption'); }
    catch (error) { if (!error.message.includes('Simulated artifact save interruption')) throw error; }
    finally { useAssistantArtifactStore.setState({ applyWorkflowDelivery: applyDelivery }); }
    const conflictIntent = (await conflictWorkflow.read(conflictId)).run.delivery;
    applyDelivery(conflictIntent.artifacts);
    useAssistantArtifactStore.setState((state) => ({ items: state.items.map((item) => item.chatId === conflictChatId
      ? { ...item, versions: item.versions.map((version) => ({ ...version, content: '用户保留的市场结论' })) } : item) }));
    try { await conflictWorkflow.publish(conflictId); throw new Error('Expected user edit conflict'); }
    catch (error) { if (!error.message.includes('产物已被修改')) throw error; }
    const conflictRun = await conflictWorkflow.read(conflictId);
    const questionId = 'browser-collab-question-' + crypto.randomUUID();
    const questionChatId = questionId + '-chat';
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: questionChatId, type: 'assistant', name: '用户答复验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null }] }));
    const questionPlan = { summary: '用户答复验证', roles: [{ id: 'lead', name: '需求分析师', responsibility: '确认需求',
      method: '询问关键事实', acceptance: '实际答复', allowedTools: ['user_input', 'text_generation'] }], tasks: [
      { id: 'question', roleId: 'lead', goal: '目标市场是哪里？', tool: 'user_input', dependsOn: [], acceptance: '真实答复' },
      { id: 'report', roleId: 'lead', goal: '给出市场建议', tool: 'text_generation', dependsOn: ['question'], acceptance: '对应市场' },
    ], finalAcceptance: '可用建议' };
    let questionRequests = 0;
    const questionFetch = async (input, init) => {
      if (!String(input).startsWith('https://delegation-smoke.invalid/')) return originalFetch(input, init);
      const request = JSON.parse(init.body);
      const index = questionRequests++;
      if (index === 1 && !JSON.stringify(request.messages).includes('日本独立开发者')) throw new Error('Real user answer missing from downstream model request');
      if (index > 1) throw new Error('Question recovery duplicated a model request');
      return Response.json({ choices: [{ message: { role: 'assistant', content: index === 0 ? JSON.stringify(questionPlan) : '面向日本独立开发者的建议' }, finish_reason: 'stop' }] });
    };
    let questionRun;
    window.fetch = questionFetch;
    try {
      questionRun = (await createAgentTeamWorkflow(config, currentWorkflowScope).start(questionId, questionChatId, '研究产品受众', false)).snapshot;
      questionRun = (await createAgentTeamWorkflow(config, currentWorkflowScope).resume(questionId)).snapshot;
      if (questionRun.run.status !== 'paused' || questionRequests !== 1
        || questionRun.tasks.find((task) => task.id === 'question').status !== 'waiting_user') throw new Error('User question did not persist across recovery');
    } finally { window.fetch = originalFetch; }
    const baseCleanup = window.__cleanupCollaborationFixture;
    window.__cleanupCollaborationFixture = async () => {
      useChatStore.setState((state) => ({ chats: state.chats.filter((chat) => chat.id !== conflictChatId && chat.id !== questionChatId) }));
      useAssistantArtifactStore.setState((state) => ({ items: state.items.filter((item) => item.chatId !== conflictChatId) }));
      useMessageStore.setState((state) => ({ messages: state.messages.filter((message) => message.chatId !== conflictChatId),
        messageWindowsByChatId: Object.fromEntries(Object.entries(state.messageWindowsByChatId).filter(([id]) => id !== conflictChatId)) }));
      await commitBufferedPersistenceWrites();
      await baseCleanup();
    };
    const resumableRun = { run: { ...run.run, id: 'browser-resume-run', status: 'paused', goalSpec: defaultWorkflowGoalSpec(run.run.goal) }, tasks: [
      { id: 'plan', runId: 'browser-resume-run', kind: 'team_plan', input: '研究市场机会', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
      { id: 'research', runId: 'browser-resume-run', kind: 'agent_text', input: { task: plan.tasks[0], role: plan.roles[0], goal: '研究市场机会' }, dependsOn: ['plan'], status: 'queued', attempt: 0, updatedAt: now },
    ] };
    const secondResumableRun = { run: { ...resumableRun.run, id: 'browser-resume-run-2', goal: '验证代码' }, tasks: [
      { id: 'plan', runId: 'browser-resume-run-2', kind: 'team_plan', input: '验证代码', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
      { id: 'research', runId: 'browser-resume-run-2', kind: 'agent_text', input: { task: plan.tasks[0], role: plan.roles[0], goal: '验证代码' }, dependsOn: ['plan'], status: 'waiting_dependency', attempt: 0, updatedAt: now },
    ] };
    const uncertainRun = { run: { ...run.run, id: 'browser-uncertain-run', status: 'paused' }, tasks: [
      { id: 'plan', runId: 'browser-uncertain-run', kind: 'team_plan', input: '研究市场机会', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
      { id: 'research', runId: 'browser-uncertain-run', kind: 'agent_text', input: { task: plan.tasks[0], role: plan.roles[0], goal: '研究市场机会' }, dependsOn: ['plan'], status: 'result_unknown', attempt: 1, updatedAt: now },
    ] };
    const container = document.createElement('div');
    container.id = 'assistant-team-smoke-root';
    document.body.append(container);
    window.__assistantTeamSmoke = { calls: [], resumed: [], limits: [], deadlines: [] };
    const [{ default: ToolHistory }, { default: ChatMessageList }, { default: ChatTimelineFrame }] = await Promise.all([
      import('/src/components/chat/TeamTaskExecutionHistory.tsx'),
      import('/src/components/chat/MessageList.tsx'),
      import('/src/components/chat/ChatTimelineFrame.tsx'),
    ]);
    const progressContainer = document.createElement('div');
    progressContainer.id = 'assistant-team-progress-smoke-root';
    document.body.append(progressContainer);
    const progressRoot = createRoot(progressContainer);
    window.__assistantTeamSmoke.progressRoot = progressRoot;
    progressRoot.render(React.createElement(React.Fragment, null,
      React.createElement(ChatMessageList, { characters: [], messages: [
      { id: 'system-fixture', chatId: 'progress-fixture', type: 'system', senderId: 'system', senderName: '提示',
        content: '普通系统提示', emotion: 0, timestamp: now - 1, isDeleted: false },
      {
      id: 'progress-fixture', chatId: 'progress-fixture', type: 'system', senderId: 'narrator', senderName: '旁白',
      content: '生成视频 · 进行中', emotion: 0, timestamp: now, isDeleted: false,
      metadata: { chatNotice: { tone: 'working', progress: { completed: 2, total: 4 },
        details: ['撰写剧本 · 已完成', '生成图片素材 · 已完成', '生成视频 · 进行中', '检查交付结果 · 排队中'] } },
    }] }),
      React.createElement(ChatTimelineFrame, { presentation: { family: 'bubble', variant: 'message', placement: 'left' }, messageId: 'left-fixture' }, '左侧'),
      React.createElement(ChatTimelineFrame, { presentation: { family: 'bubble', variant: 'message', placement: 'right' }, messageId: 'right-fixture' }, '右侧')));
    const historyContainer = document.createElement('div');
    historyContainer.id = 'assistant-tool-history-smoke-root';
    document.body.append(historyContainer);
    const historyRoot = createRoot(historyContainer);
    window.__assistantTeamSmoke.historyRoot = historyRoot;
    historyRoot.render(React.createElement(ToolHistory, { runId: toolRunId, taskId: 'research', updatedAt: toolRun.tasks[0].updatedAt,
      statusLabels: { completed: '已完成' } }));
    const root = createRoot(container);
    window.__assistantTeamSmoke.root = root;
    root.render(React.createElement(Workbench, {
      open: true, onClose: () => {},
      runs: [{ ...persistedRun, run: { ...persistedRun.run, deliveryStatus: 'pending', deliveryIssue: 'save_failed' } }, resumableRun, secondResumableRun, uncertainRun, recursiveRun, conflictRun, outputRun, questionRun, capabilityRun], canRun: true, isRunActive: () => false, onResume: () => {},
      onResumeAll: async (items) => { window.__assistantTeamSmoke.resumed = items.map((item) => item.run.id); },
      onInstruct: async () => {}, onPause: async () => {},
      onAnswer: async (item, task, answer) => {
        window.fetch = questionFetch;
        try {
          const workflow = createAgentTeamWorkflow(config, currentWorkflowScope);
          await workflow.answerUserInput(item.run.id, task.id, item.run.planVersion, answer);
          const restored = createAgentTeamWorkflow(config, currentWorkflowScope);
          const completed = (await restored.resume(item.run.id)).snapshot;
          await createAgentTeamWorkflow(config, currentWorkflowScope).resume(item.run.id);
          const saved = await restored.read(item.run.id);
          const response = saved.tasks.find((entry) => entry.id === task.id);
          if (completed.run.status !== 'completed' || response.output !== answer || response.userResponse.actor !== 'local_user'
            || response.userResponse.planVersion !== item.run.planVersion || questionRequests !== 2) throw new Error('Answer was not saved or recovery repeated generation');
          window.__assistantTeamSmoke.userResponse = { completed: true, modelRequests: questionRequests, answer: response.output };
        } finally { window.fetch = originalFetch; }
      },
      onUpdateModelCallLimit: async (item, limit) => { window.__assistantTeamSmoke.limits.push({ runId: item.run.id, limit }); },
      onUpdateDeadline: async (item, deadlineAt) => { window.__assistantTeamSmoke.deadlines.push({ runId: item.run.id, deadlineAt }); },
      onSaveDeliveryCopy: async (item) => {
        await conflictWorkflow.publish(item.run.id, item.run.planVersion);
        await createAgentTeamWorkflow(config, currentWorkflowScope).publish(item.run.id);
        const saved = await conflictWorkflow.read(item.run.id);
        const artifacts = useAssistantArtifactStore.getState().getArtifactsForChat(conflictChatId);
        const messages = useMessageStore.getState().messageWindowsByChatId[conflictChatId]?.messages || [];
        const copy = saved.run.deliveryCopy;
        if (saved.run.decisions?.length !== 1 || saved.run.decisions[0].action !== 'preserve_and_copy_delivery'
          || saved.run.decisions[0].planVersion !== copy.planVersion) throw new Error('Copy decision was lost or duplicated on recovery');
        const chat = useChatStore.getState().chats.find((entry) => entry.id === conflictChatId);
        if (saved.run.deliveryStatus !== 'published' || artifacts.length !== 2
          || artifacts.find((entry) => entry.id === conflictIntent.artifacts[0].after.id)?.versions[0].content !== '用户保留的市场结论'
          || messages.filter((entry) => entry.id === copy.message.id).length !== 1
          || chat.messageBranchState.refs.main.headNodeId !== copy.message.id
          || copy.message.metadata.branching.nodeId !== copy.message.id) throw new Error('Copy publication lost content or duplicated delivery');
        window.__assistantTeamSmoke.deliveryCopy = { artifacts: artifacts.length, messages: messages.length, published: true, sourcePreserved: true, decisions: saved.run.decisions.length };
      },
      onDelegate: async (...args) => {
        const [selected, request, targetTaskId] = args;
        const workflow = createAgentTeamWorkflow(config, currentWorkflowScope);
        const updated = await workflow.addRevisionRequest(selected.run.id, selected.run.planVersion, request, targetTaskId);
        const restored = await createAgentTeamWorkflow(config, currentWorkflowScope).read(selected.run.id);
        const impact = restored.tasks.find((task) => task.kind === 'team_plan_revision').input.impact;
        if (updated.run.planVersion !== selected.run.planVersion + 1 || impact.targetTaskId !== targetTaskId
          || !impact.affectedTaskIds.includes(targetTaskId)) throw new Error('Targeted revision was not persisted');
        window.__assistantTeamSmoke.revisionImpact = impact;
        window.__assistantTeamSmoke.calls.push(args);
      },
      onAbandonReview: async () => {}, onResumeAfterReviewRetry: async () => {}, onResumeAfterTaskRetry: async (item, task) => {
        if (item.run.id === capabilityRunId) await retryCapability(item, task);
        else await retryOutput(item, task);
      },
    }));
    return true;
  })()`);
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[role="dialog"]'))`), 'workbench mounted');
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).some((button) => button.textContent?.includes('市场分析师'))`), 'child agent selector');
  await waitFor(() => cdp.evaluate(`document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes('交付尚未保存完成') && document.querySelector('[role="dialog"]').textContent.includes('交付需要处理')`), 'pending delivery error visible');
  assert.equal(await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).some((button) => button.textContent === '检查交付')`), true);
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).some((button) => button.textContent?.includes('恢复所有可恢复任务 (2)'))`), 'bulk resume action');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent?.includes('恢复所有可恢复任务')).click()`);
  await waitFor(() => cdp.evaluate(`window.__assistantTeamSmoke?.resumed.length === 2`), 'recoverable runs resumed');
  const resumedIds = await cdp.evaluate(`window.__assistantTeamSmoke.resumed`);
  assert.deepEqual(resumedIds, ['browser-resume-run', 'browser-resume-run-2']);
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('#assistant-team-progress-smoke-root [aria-label="聊天提示"]'))`), 'chat notice rendered');
  assert.equal(await cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root [data-message-id="left-fixture"]')?.dataset.timelinePlacement`), 'left');
  assert.equal(await cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root [data-message-id="right-fixture"]')?.dataset.timelinePlacement`), 'right');
  assert.equal(await cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root [data-message-id="left-fixture"]')?.dataset.timelineFamily`), 'bubble');
  assert.equal(await cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root [data-message-id="right-fixture"]')?.dataset.timelineVariant`), 'message');
  assert.equal(await cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root [data-message-id="system-fixture"][data-timeline-placement]')?.dataset.timelinePlacement`), 'center');
  assert.equal(await cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root [data-message-id="progress-fixture"][data-timeline-placement]')?.dataset.timelinePlacement`), 'center');
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('#assistant-team-progress-smoke-root [aria-label="正在执行"]'))`), true);
  assert.equal(await cdp.evaluate(`(() => { const notice = document.querySelector('#assistant-team-progress-smoke-root [aria-label="聊天提示"]'); return notice.getBoundingClientRect().width < document.querySelector('#assistant-team-progress-smoke-root').getBoundingClientRect().width * 0.75; })()`), true);
  assert.match(await cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root').textContent`), /生成视频 · 进行中.*2\/4/);
  assert.doesNotMatch(await cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root').textContent`), /撰写剧本|检查交付结果/);
  await cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root button[aria-label="展开提示详情"]').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root').textContent.includes('撰写剧本 · 已完成')`), 'progress details expanded');
  assert.match(await cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root').textContent`), /检查交付结果 · 排队中/);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await cdp.evaluate(`document.querySelector('#assistant-team-progress-smoke-root').scrollWidth <= 390`), true);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find((button) => button.textContent?.includes('市场分析师')).click()`);
  await waitFor(() => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll('[role="dialog"] label')).find((label) => label.textContent?.includes('与该子 Agent 继续协作')))`), 'child instruction input');
  assert.match(await cdp.evaluate(`document.querySelector('[role="dialog"]').textContent`), /可能影响 1 个步骤：研究市场竞争/);
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === '查看执行记录').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('[aria-label="任务执行记录"]')?.textContent.includes('第 1 次执行 · 已完成 · 计划 2')`), 'persisted execution history visible');
  assert.doesNotMatch(await cdp.evaluate(`document.querySelector('[aria-label="任务执行记录"]').textContent`), /browser-collab-|research|agent_text/);
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[role="dialog"] textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '补充日本市场，并标注数据年份');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent?.includes('发送给主 Agent')).click()`);
  await waitFor(() => cdp.evaluate(`window.__assistantTeamSmoke?.calls.length === 1`), 'revision request submitted');
  const request = await cdp.evaluate(`window.__assistantTeamSmoke.calls[0][1]`);
  assert.equal(await cdp.evaluate(`window.__assistantTeamSmoke.calls[0][2]`), 'research');
  assert.deepEqual(await cdp.evaluate(`window.__assistantTeamSmoke.revisionImpact.affectedTaskIds`), ['research']);
  assert.match(request, /市场分析师/);
  assert.match(request, /原任务：研究市场竞争/);
  assert.match(request, /补充日本市场，并标注数据年份/);
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).filter((button) => button.textContent === '市场研究')[1].click()`);
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[role="dialog"] input[type="number"]'))`), 'model call limit input');
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[role="dialog"] input[type="number"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '12');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === '保存调用上限').click()`);
  await waitFor(() => cdp.evaluate(`window.__assistantTeamSmoke.limits.length === 1`), 'model call limit saved');
  assert.deepEqual(await cdp.evaluate(`window.__assistantTeamSmoke.limits[0]`), { runId: 'browser-resume-run', limit: 12 });
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === '保存截止时间').click()`);
  await waitFor(() => cdp.evaluate(`window.__assistantTeamSmoke.deadlines.length === 1`), 'deadline cleared through workbench');
  assert.deepEqual(await cdp.evaluate(`window.__assistantTeamSmoke.deadlines[0]`), { runId: 'browser-resume-run' });
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find((button) => button.textContent === '研究机会').click()`);
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).filter((button) => button.textContent.includes('研究负责人')).length === 3`), 'recursive child tasks visible');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).filter((button) => button.textContent.includes('研究负责人')).at(-1).click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('[role="dialog"]').textContent.includes('整理资料') && document.querySelector('[role="dialog"]').textContent.includes('证据：离线使用需求')`), 'nested child delivery visible');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find((button) => button.textContent === '交付冲突验证').click()`);
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).some((button) => button.textContent === '对照当前内容与候选交付')`), 'delivery comparison action');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === '对照当前内容与候选交付').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('[role="dialog"]').textContent.includes('用户保留的市场结论') && document.querySelector('[role="dialog"]').textContent.includes('候选交付')`), 'current and candidate content visible');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === '保留现有内容，另存交付').click()`);
  await waitFor(() => cdp.evaluate(`window.__assistantTeamSmoke.deliveryCopy?.published`), 'copy saved through workbench without overwriting original');
  assert.deepEqual(await cdp.evaluate(`window.__assistantTeamSmoke.deliveryCopy`), { artifacts: 2, messages: 1, published: true, sourcePreserved: true, decisions: 1 });
  await cdp.evaluate(`document.querySelector('#assistant-tool-history-smoke-root button').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('#assistant-tool-history-smoke-root')?.textContent.includes('工具执行已完成')`), 'persisted tool history visible');
  assert.doesNotMatch(await cdp.evaluate(`document.querySelector('#assistant-tool-history-smoke-root').textContent`), /browser-collab-|agent_web_search|research/);
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find((button) => button.textContent === 'JSON交付验证').click()`);
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).some((button) => button.textContent.includes('市场分析师 · 失败'))`), 'invalid output task visible');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find((button) => button.textContent.includes('市场分析师 · 失败')).click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('[role="dialog"]').textContent.includes('JSON 不符合已声明的字段契约')`), 'output validation error visible');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === '重试该任务并继续').click()`);
  await waitFor(() => cdp.evaluate(`window.__assistantTeamSmoke.outputRetry === true`), 'failed JSON retried from workbench with preserved upstream');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find((button) => button.textContent === '能力恢复验证').click()`);
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find((button) => button.textContent.includes('市场分析师 · 失败')).click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('[role="dialog"] [role="status"]')?.textContent.includes('继续条件') && document.querySelector('[role="dialog"] [role="status"]').textContent.includes('配置对应类型的模型')`), 'persisted capability recovery condition visible');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === '重试该任务并继续').click()`);
  await waitFor(() => cdp.evaluate(`window.__assistantTeamSmoke.capabilityRecovery === true`), 'capability repair retries only blocked step');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find((button) => button.textContent === '用户答复验证').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('[role="dialog"]').textContent.includes('目标市场是哪里？')`), 'persisted user question visible');
  await cdp.evaluate(`(() => {
    const input = Array.from(document.querySelectorAll('[role="dialog"] textarea')).find((entry) => entry.id && document.querySelector('label[for="' + entry.id + '"]')?.textContent.includes('你的答复'));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '日本独立开发者');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === '答复并继续').click()`);
  await waitFor(() => cdp.evaluate(`window.__assistantTeamSmoke.userResponse?.completed`), 'user answer persisted and downstream resumed');
  assert.deepEqual(await cdp.evaluate(`window.__assistantTeamSmoke.userResponse`), { completed: true, modelRequests: 2, answer: '日本独立开发者' });
  const narrationRequest = await cdp.evaluate(`(async () => {
    const { synthesizeSpeech } = await import('/src/services/speech.ts');
    const originalFetch = window.fetch;
    let request;
    const workflowUsage = { schemaVersion: 1, runId: 'browser-narration', taskId: 'narration', attempt: 2, kind: 'tool' };
    window.fetch = async (input, init) => {
      const url = new URL(String(input), location.origin);
      if (url.pathname !== '/api/speech/tts') return originalFetch(input, init);
      request = JSON.parse(init.body);
      return new Response(JSON.stringify({ provider: 'fixture', mimeType: 'audio/wav', audioDataUrl: 'data:audio/wav;base64,AAAA' }), { headers: { 'Content-Type': 'application/json' } });
    };
    try {
      await synthesizeSpeech({ text: '旁白正文', workflowUsage });
      return request;
    } finally { window.fetch = originalFetch; }
  })()`);
  assert.deepEqual(narrationRequest, { text: '旁白正文', workflowUsage: { schemaVersion: 1, runId: 'browser-narration', taskId: 'narration', attempt: 2, kind: 'tool' } });
  await cdp.evaluate(`(async () => {
    const [{ useAuthStore }, { api }, { default: Panel }, { default: BudgetPanel }] = await Promise.all([
      import('/src/stores/useAuthStore.ts'), import('/src/services/api.ts'), import('/src/components/chat/TeamUsagePanel.tsx'),
      import('/src/components/chat/TeamBudgetPanel.tsx'),
    ]);
    const main = await (await fetch('/src/main.tsx')).text();
    const dependency = (name) => main.split('"').find((part) => part.startsWith('/node_modules/.vite/deps/' + name + '.js?'));
    const [react, dom] = await Promise.all([import(dependency('react')), import(dependency('react-dom_client'))]);
    const React = react.default || react;
    const auth = useAuthStore.getState();
    const originalQuery = api.getWorkflowUsage;
    const originalBudgetQuery = api.getWorkflowBudget;
    const originalBudgetSave = api.configureWorkflowBudget;
    const container = document.createElement('div');
    container.id = 'workflow-usage-smoke';
    document.body.appendChild(container);
    const root = (dom.createRoot || dom.default?.createRoot)(container);
    window.__usageCalls = 0;
    window.__budgetCalls = 0;
    window.__budgetSaves = [];
    window.__usageCleanup = () => {
      root.unmount(); container.remove(); api.getWorkflowUsage = originalQuery;
      api.getWorkflowBudget = originalBudgetQuery; api.configureWorkflowBudget = originalBudgetSave;
      useAuthStore.setState({ token: auth.token, isLoggedIn: auth.isLoggedIn });
    };
    api.getWorkflowUsage = async (runId) => {
      if (runId !== 'fee-fixture') throw new Error('Wrong Run queried');
      if (++window.__usageCalls === 1) throw new Error('费用暂时不可用');
      return { coverage: 'available_server_records', asOf: Date.now(), units: [
        { billingUnit: 'point', settledAmount: '0.300003', reservedAmount: '0.500000', settledRequests: 2, pendingRequests: 1, unpricedRequests: 1 },
        { billingUnit: 'usd', settledAmount: '0.100000', reservedAmount: '0', settledRequests: 1, pendingRequests: 0, unpricedRequests: 0 },
      ] };
    };
    api.getWorkflowBudget = async (runId) => {
      if (runId !== 'fee-fixture') throw new Error('Wrong budget Run queried');
      window.__budgetCalls++;
      return null;
    };
    api.configureWorkflowBudget = async (runId, input) => {
      window.__budgetSaves.push({ runId, ...input });
      if (window.__budgetSaves.length > 1) throw new Error('预算已更新，请刷新后重试');
      return { schemaVersion: 1, runId, billingUnit: input.billingUnit, limitAmount: '12.345678', revision: 1,
        committedAmount: '3.000000', reservedAmount: '1.000000', remainingAmount: '9.345678',
        exceeded: false, unresolvedRequests: 1, updatedAt: Date.now() };
    };
    useAuthStore.setState({ token: 'browser-fixture-only', isLoggedIn: true });
    root.render(React.createElement(React.Fragment, null,
      React.createElement(Panel, { runId: 'fee-fixture' }),
      React.createElement(BudgetPanel, { runId: 'fee-fixture', canEdit: true,
        onSave: (input) => api.configureWorkflowBudget('fee-fixture', input) })));
  })()`);
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('#workflow-usage-smoke button'))`), 'on-demand fee action');
  assert.equal(await cdp.evaluate(`window.__usageCalls`), 0, 'Mounting must not query fees');
  assert.equal(await cdp.evaluate(`window.__budgetCalls`), 0, 'Mounting must not query budgets');
  await cdp.evaluate(`document.querySelector('#workflow-usage-smoke button').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('#workflow-usage-smoke [role="alert"]')?.textContent.includes('费用暂时不可用')`), 'fee error visible');
  await cdp.evaluate(`document.querySelector('#workflow-usage-smoke button').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('#workflow-usage-smoke')?.textContent.includes('已结算 0.300003 积分')`), 'settled and reserved amounts visible');
  assert.match(await cdp.evaluate(`document.querySelector('#workflow-usage-smoke').textContent`), /预留 0.500000 积分.*费用未知 1 次.*0.100000 美元/s);
  await cdp.evaluate(`Array.from(document.querySelectorAll('#workflow-usage-smoke button')).find((button) => button.textContent === '任务预算').click()`);
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('#workflow-usage-smoke input'))`), 'budget editor available');
  await cdp.evaluate(`document.querySelector('#workflow-usage-smoke input').focus()`);
  await cdp.send('Input.insertText', { text: '12.345678' });
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('#workflow-usage-smoke button')).some((button) => button.textContent === '保存预算' && !button.disabled)`), 'valid decimal budget');
  await cdp.evaluate(`Array.from(document.querySelectorAll('#workflow-usage-smoke button')).find((button) => button.textContent === '保存预算').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('#workflow-usage-smoke')?.textContent.includes('剩余 9.345678 积分')`), 'saved budget and remaining amount');
  assert.deepEqual(await cdp.evaluate(`window.__budgetSaves`), [{ runId: 'fee-fixture', limitAmount: '12.345678', billingUnit: 'point', expectedRevision: 0 }]);
  assert.match(await cdp.evaluate(`document.querySelector('#workflow-usage-smoke').textContent`), /1 次调用的费用待核对/);
  await cdp.evaluate(`Array.from(document.querySelectorAll('#workflow-usage-smoke button')).find((button) => button.textContent === '保存预算').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('#workflow-usage-smoke')?.textContent.includes('预算已更新，请刷新后重试')`), 'budget revision conflict surfaced');
  assert.equal(await cdp.evaluate(`window.__budgetSaves[1].expectedRevision`), 1);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await cdp.evaluate(`document.querySelector('#workflow-usage-smoke').scrollWidth <= 390`), true);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  assert.equal(await cdp.evaluate(`window.__usageCalls`), 2, 'Rendering and resizing must not poll fees');
  assert.equal(await cdp.evaluate(`window.__budgetCalls`), 1, 'Rendering and resizing must not poll budgets');
  await cdp.evaluate(`window.__usageCleanup()`);
  console.log(JSON.stringify({ ok: true, capabilityRecovery: await cdp.evaluate(`window.__assistantTeamSmoke.capabilityRecovery`), userResponse: await cdp.evaluate(`window.__assistantTeamSmoke.userResponse`), outputContractRetry: true, exactSavedTextRecovery: true, toolHistory: true, deliveryCopy: await cdp.evaluate(`window.__assistantTeamSmoke.deliveryCopy`), deadlineRecovery: true, recursiveDelegation: true, sharedBudgetRecovery: true, recursiveModelRequests: 6, planRevisionJournal: true, revisionRollback: true, executionHistory: '第 1 次执行 · 已完成 · 计划 2', childRole: '市场分析师', resumedRunIds: resumedIds, revisionRequest: request }));
} catch (error) {
  console.error(JSON.stringify({ browserErrors: cdp.errors }));
  throw error;
} finally {
  await cdp.evaluate(`window.__usageCleanup?.()`).catch((error) => console.error('Usage fixture cleanup failed:', error));
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.evaluate(`(async () => { window.__assistantTeamSmoke?.root?.unmount(); window.__assistantTeamSmoke?.historyRoot?.unmount(); window.__assistantTeamSmoke?.progressRoot?.unmount(); document.querySelector('#assistant-team-smoke-root')?.remove(); document.querySelector('#assistant-tool-history-smoke-root')?.remove(); document.querySelector('#assistant-team-progress-smoke-root')?.remove(); await window.__cleanupCollaborationFixture?.(); })()`).catch((error) => console.error('Fixture cleanup failed:', error));
  cdp.close();
}
