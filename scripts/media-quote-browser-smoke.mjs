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
const pending = new Map();
const requests = [];
const quote = { schemaVersion: 1, id: 'a'.repeat(64), model: 'fixture-video', modality: 'video',
  requestSha256: 'b'.repeat(64), costQuoteId: 'c'.repeat(64), amount: '1.250000', unit: 'credit',
  kind: 'request_tariff', capturedAt: Date.now(), expiresAt: Date.now() + 300_000, token: 'd'.repeat(64) };
quote.expiresAt = quote.capturedAt + 300_000;
let interceptionError;
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data.toString());
  if (message.method === 'Fetch.requestPaused') {
    const { requestId, request } = message.params;
    requests.push({ url: request.url, body: JSON.parse(request.postData || '{}') });
    const body = new URL(request.url).pathname.endsWith('/quotes') ? quote : { task_id: 'fixture-accepted', status: 'running' };
    void send('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(body)).toString('base64'),
    }).catch((error) => { interceptionError = error; });
  }
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id); clearTimeout(item.timer);
  if (message.error) item.reject(new Error(message.error.message));
  else item.resolve(message.result);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function navigateAndWait(method, params = {}) {
  let timer;
  let listener;
  const loaded = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('page navigation timed out')), 20_000);
    listener = (event) => {
      if (JSON.parse(event.data.toString()).method === 'Page.loadEventFired') resolve();
    };
    socket.addEventListener('message', listener);
  });
  try { await send(method, params); await loaded; }
  finally { clearTimeout(timer); socket.removeEventListener('message', listener); }
}
try {
  await send('Fetch.enable', { patterns: [{ urlPattern: '*ai/media/*', requestStage: 'Request' }] });
  await send('Page.enable');
  await navigateAndWait('Page.navigate', { url: baseUrl });
  const runId = `browser-quote-${Date.now()}`;
  const bootstrap = `
    const { prepareAiMediaTask, submitPreparedAiMediaTask } = await import('/src/services/aiClient.ts');
    const { createWorkflowRunRuntime, indexedDbWorkflowRepository } = await import('/src/services/workflowRunRuntime.ts');
    const runId = ${JSON.stringify(runId)};
    const options = { profile: { provider: 'official-ace', model: 'fixture-video' }, prompt: 'browser fixture',
      parameters: { duration: 5, resolution: '720p', image_urls: ['data:image/png;base64,AA=='] },
      clientRequestKey: runId, aiUsage: { type: 'video_generation',
        workflow: { schemaVersion: 1, runId, taskId: 'shot', attempt: 1, kind: 'tool' } } };
    const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
      tracksToolInvocations: true,
      approvalRequirement: (task) => ({ summary: '生成短片', consequences: '会产生费用', mediaExecution: task.approvals?.at(-1)?.mediaExecution }),
      prepareApprovalRequirement: async (_task, _snapshot, requirement, signal) => requirement.mediaExecution ? requirement
        : { ...requirement, mediaExecution: await prepareAiMediaTask({ ...options, signal }) },
      execute: async (task, _signal, context) => {
        await context.beginToolInvocation();
        const submitted = await submitPreparedAiMediaTask(task.approvals.at(-1).mediaExecution);
        return { output: submitted.task_id };
      },
    }, () => runId);
  `;
  const result = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    ${bootstrap}
    await runtime.create({ run: { id: runId, chatId: 'fixture-chat', goal: '生成视频', status: 'active', planVersion: 1, generation: 0, updatedAt: Date.now() },
      tasks: [{ id: 'shot', runId, kind: 'agent_video', input: 'browser fixture', dependsOn: [], status: 'queued', attempt: 0, updatedAt: Date.now() }] });
    const pending = await runtime.resume(runId);
    return { quote: pending.tasks[0].approvals[0].mediaExecution.quote, status: pending.tasks[0].status, attempt: pending.tasks[0].attempt };
  })()` });
  if (interceptionError) throw interceptionError;
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  assert.deepEqual(result.result.value, { quote, status: 'waiting_user', attempt: 0 });
  assert.equal(requests.length, 1, 'no generation before consent');
  await navigateAndWait('Page.reload');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const resumed = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    ${bootstrap}
    const restored = await runtime.read(runId);
    const source = await (await fetch('/src/main.tsx')).text();
    const dependency = (name) => source.split('"').find((part) => part.startsWith('/node_modules/.vite/deps/' + name + '.js?'));
    const [react, dom, { default: Panel }] = await Promise.all([import(dependency('react')), import(dependency('react-dom_client')), import('/src/components/chat/TeamApprovalPanel.tsx')]);
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;inset:0;background:white;padding:16px;box-sizing:border-box;z-index:99999;overflow:auto';
    document.body.appendChild(container);
    const root = (dom.createRoot || dom.default?.createRoot)(container);
    let finish; let fail;
    const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    root.render((react.createElement || react.default?.createElement)(Panel, { run: restored, task: restored.tasks[0], disabled: false,
      onDecide: async (run, task, outcome) => {
        try {
          await runtime.decideApproval(runId, task.id, run.run.planVersion, outcome);
          finish(await runtime.resume(runId));
        } catch (error) { fail(error); throw error; }
      } }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const text = container.textContent;
    if (!text.includes('fixture-video') || !text.includes('1.250000') || !text.includes('报价有效至')) throw new Error('Quote details missing from approval UI');
    if (text.includes('d'.repeat(64))) throw new Error('Signing token leaked into approval UI');
    if (container.scrollWidth > container.clientWidth) throw new Error('Mobile approval overflows');
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '批准本次执行').click();
    const completed = await done;
    root.unmount(); container.remove();
    await runtime.resume(runId);
    return { status: completed.run.status, taskId: completed.tasks[0].output };
  })()` });
  if (resumed.exceptionDetails) throw new Error(resumed.exceptionDetails.exception?.description || resumed.exceptionDetails.text);
  assert.deepEqual(resumed.result.value, { status: 'completed', taskId: 'fixture-accepted' });
  assert.equal(requests.length, 2);
  assert.ok(new URL(requests[0].url).pathname.endsWith('/ai/media/quotes'));
  assert.ok(new URL(requests[1].url).pathname.endsWith('/ai/media/generations'));
  const { execution_quote: approved, ...generation } = requests[1].body;
  assert.deepEqual(approved, quote);
  assert.deepEqual(generation, requests[0].body);
  console.log('PASS: IndexedDB approval survives reload; 390px approval UI shows quote without token, its approval button submits exact quoted parameters once; fixture responses, no paid generation');
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  socket.close();
  await fetch(`${cdpUrl}/json/close/${target.id}`);
}
