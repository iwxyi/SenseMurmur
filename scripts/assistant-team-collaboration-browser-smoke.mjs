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
      import(dependencyUrl('react')), import(dependencyUrl('react-dom_client')), import('/src/components/chat/AssistantTeamWorkbench.tsx'),
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
    const { createWorkflowRunRuntime, indexedDbWorkflowRepository, currentWorkflowScope } = await import('/src/services/workflowRunRuntime.ts');
    const { defaultWorkflowGoalSpec } = await import('/src/services/workflowGoalSpec.ts');
    window.__cleanupCollaborationFixture = async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pneumata-workflow-runs', 5);
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
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
      execute: async () => ({ output: '主要竞争者采用订阅模式' }),
    }, currentWorkflowScope);
    await runtime.create({ ...run, run: { ...run.run, status: 'active' }, tasks: run.tasks.map((task) => task.id === 'research' ? { ...task, status: 'queued', attempt: 0, output: undefined } : task) });
    const persistedRun = await runtime.resume(runId);
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
      tasks: [{ id, roleId: 'lead', goal, tool, dependsOn: [], acceptance: '有依据' }], finalAcceptance: '可用报告' });
    const replies = [recursivePlan('research', '研究机会', 'delegate_task'), recursivePlan('market', '分析市场', 'delegate_task'),
      recursivePlan('evidence', '整理资料', 'text_generation'), '证据：离线使用需求', '市场交付：优先离线', '研究交付：离线方案'];
    const config = { provider: 'openai', baseUrl: 'https://delegation-smoke.invalid/v1', apiKey: 'test-fixture', model: 'fixture' };
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
      await restored.setModelCallLimit(recursiveId, saved.run.planVersion, 6);
      recursiveRun = (await restored.resume(recursiveId)).snapshot;
      if (recursiveRun.run.status !== 'completed' || recursiveRequests !== 6
        || recursiveRun.tasks.find((task) => task.id === 'research').output !== '研究交付：离线方案') throw new Error('Nested recovery or parent synthesis failed');
      await createAgentTeamWorkflow(config, currentWorkflowScope).resume(recursiveId);
      if (recursiveRequests !== 6) throw new Error('Recovery duplicated model requests');
      const attempts = await indexedDbWorkflowRepository.listTaskAttempts(currentWorkflowScope(), recursiveId, 'research');
      if (attempts.length !== 2 || attempts.some((attempt) => attempt.status !== 'completed')) throw new Error('Delegation attempt journal incomplete');
    } finally {
      window.fetch = originalFetch;
      useChatStore.setState((state) => ({ chats: state.chats.filter((chat) => chat.id !== recursiveChatId) }));
    }
    const textRunId = 'browser-collab-saved-text-' + crypto.randomUUID();
    const textChatId = textRunId + '-chat';
    const originalText = '逐字保留：' + '完整研究正文。'.repeat(400) + '末尾结论必须保留';
    const textSnapshot = { ...run, run: { ...run.run, id: textRunId, chatId: textChatId, autoReview: false },
      tasks: run.tasks.map((task) => ({ ...task, runId: textRunId, ...(task.id === 'research' ? { output: originalText } : {}) })) };
    await runtime.create(textSnapshot);
    const { listTeamSavedText } = await import('/src/services/agentTeamSavedText.ts');
    const savedText = listTeamSavedText(textSnapshot, ['research']).map((entry) => ({ ...entry, alias: 'original_report' }));
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: textChatId, type: 'assistant', name: '历史正文验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null }] }));
    let savedTextRequests = 0;
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
    const baseCleanup = window.__cleanupCollaborationFixture;
    window.__cleanupCollaborationFixture = async () => {
      useChatStore.setState((state) => ({ chats: state.chats.filter((chat) => chat.id !== conflictChatId) }));
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
    const { default: ToolHistory } = await import('/src/components/chat/TeamTaskExecutionHistory.tsx');
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
      runs: [{ ...persistedRun, run: { ...persistedRun.run, deliveryStatus: 'pending', deliveryIssue: 'save_failed' } }, resumableRun, secondResumableRun, uncertainRun, recursiveRun, conflictRun, outputRun], canRun: true, isRunActive: () => false, onResume: () => {},
      onResumeAll: async (items) => { window.__assistantTeamSmoke.resumed = items.map((item) => item.run.id); }, onCreate: () => {},
      onInstruct: async () => {}, onPause: async () => {},
      onUpdateModelCallLimit: async (item, limit) => { window.__assistantTeamSmoke.limits.push({ runId: item.run.id, limit }); },
      onUpdateDeadline: async (item, deadlineAt) => { window.__assistantTeamSmoke.deadlines.push({ runId: item.run.id, deadlineAt }); },
      onSaveDeliveryCopy: async (item) => {
        await conflictWorkflow.publish(item.run.id, item.run.planVersion);
        await createAgentTeamWorkflow(config, currentWorkflowScope).publish(item.run.id);
        const saved = await conflictWorkflow.read(item.run.id);
        const artifacts = useAssistantArtifactStore.getState().getArtifactsForChat(conflictChatId);
        const messages = useMessageStore.getState().messageWindowsByChatId[conflictChatId]?.messages || [];
        const copy = saved.run.deliveryCopy;
        const chat = useChatStore.getState().chats.find((entry) => entry.id === conflictChatId);
        if (saved.run.deliveryStatus !== 'published' || artifacts.length !== 2
          || artifacts.find((entry) => entry.id === conflictIntent.artifacts[0].after.id)?.versions[0].content !== '用户保留的市场结论'
          || messages.filter((entry) => entry.id === copy.message.id).length !== 1
          || chat.messageBranchState.refs.main.headNodeId !== copy.message.id
          || copy.message.metadata.branching.nodeId !== copy.message.id) throw new Error('Copy publication lost content or duplicated delivery');
        window.__assistantTeamSmoke.deliveryCopy = { artifacts: artifacts.length, messages: messages.length, published: true, sourcePreserved: true };
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
      onAbandonReview: async () => {}, onResumeAfterReviewRetry: async () => {}, onResumeAfterTaskRetry: retryOutput,
    }));
    return true;
  })()`);
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('#assistant-team-smoke-root button')).some((button) => button.textContent?.includes('工作台'))`), 'workbench mounted');
  await cdp.evaluate(`Array.from(document.querySelectorAll('#assistant-team-smoke-root button')).find((button) => button.textContent?.includes('工作台')).click()`);
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).some((button) => button.textContent?.includes('市场分析师'))`), 'child agent selector');
  await waitFor(() => cdp.evaluate(`document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes('交付尚未保存完成') && document.querySelector('[role="dialog"]').textContent.includes('交付需处理')`), 'pending delivery error visible');
  assert.equal(await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).some((button) => button.textContent === '检查交付')`), true);
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).some((button) => button.textContent?.includes('恢复所有可恢复任务 (2)'))`), 'bulk resume action');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent?.includes('恢复所有可恢复任务')).click()`);
  await waitFor(() => cdp.evaluate(`window.__assistantTeamSmoke?.resumed.length === 2`), 'recoverable runs resumed');
  const resumedIds = await cdp.evaluate(`window.__assistantTeamSmoke.resumed`);
  assert.deepEqual(resumedIds, ['browser-resume-run', 'browser-resume-run-2']);
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
  assert.deepEqual(await cdp.evaluate(`window.__assistantTeamSmoke.deliveryCopy`), { artifacts: 2, messages: 1, published: true, sourcePreserved: true });
  await cdp.evaluate(`document.querySelector('#assistant-tool-history-smoke-root button').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('#assistant-tool-history-smoke-root')?.textContent.includes('工具执行已完成')`), 'persisted tool history visible');
  assert.doesNotMatch(await cdp.evaluate(`document.querySelector('#assistant-tool-history-smoke-root').textContent`), /browser-collab-|agent_web_search|research/);
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find((button) => button.textContent === 'JSON交付验证').click()`);
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).some((button) => button.textContent.includes('市场分析师 · 失败'))`), 'invalid output task visible');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find((button) => button.textContent.includes('市场分析师 · 失败')).click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('[role="dialog"]').textContent.includes('JSON 不符合已声明的字段契约')`), 'output validation error visible');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === '重试该任务并继续').click()`);
  await waitFor(() => cdp.evaluate(`window.__assistantTeamSmoke.outputRetry === true`), 'failed JSON retried from workbench with preserved upstream');
  console.log(JSON.stringify({ ok: true, outputContractRetry: true, exactSavedTextRecovery: true, toolHistory: true, deliveryCopy: await cdp.evaluate(`window.__assistantTeamSmoke.deliveryCopy`), deadlineRecovery: true, recursiveDelegation: true, sharedBudgetRecovery: true, recursiveModelRequests: 6, planRevisionJournal: true, revisionRollback: true, executionHistory: '第 1 次执行 · 已完成 · 计划 2', childRole: '市场分析师', resumedRunIds: resumedIds, revisionRequest: request }));
} catch (error) {
  console.error(JSON.stringify({ browserErrors: cdp.errors }));
  throw error;
} finally {
  await cdp.evaluate(`(async () => { window.__assistantTeamSmoke?.root?.unmount(); window.__assistantTeamSmoke?.historyRoot?.unmount(); document.querySelector('#assistant-team-smoke-root')?.remove(); document.querySelector('#assistant-tool-history-smoke-root')?.remove(); await window.__cleanupCollaborationFixture?.(); })()`).catch((error) => console.error('Fixture cleanup failed:', error));
  cdp.close();
}
