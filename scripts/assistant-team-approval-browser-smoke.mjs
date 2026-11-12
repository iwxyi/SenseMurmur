import assert from 'node:assert/strict';

const baseUrl = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5173';
const cdpUrl = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';
const pages = await (await fetch(`${cdpUrl}/json/list`)).json();
const page = pages.find((item) => item.type === 'page');
assert.ok(page, 'Chrome must expose a page through CDP');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data.toString());
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function waitFor(expression) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition timed out: ${expression}`);
}
const runId = `browser-approval-${crypto.randomUUID()}`;
const setup = `(async () => {
  const { createWorkflowRunRuntime, indexedDbWorkflowRepository } = await import('/src/services/workflowRunRuntime.ts');
  window.__approvalRuntime = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
    execute: async () => {
      window.__approvalCalls = (window.__approvalCalls || 0) + 1;
      return { output: '确认后的交付' };
    },
    approvalRequirement: () => ({ summary: '确认制作方案', consequences: '执行会消耗模型额度，具体费用以实际结算为准' }),
  }, () => 'browser-approval-smoke');
})()`;
try {
  await send('Page.enable');
  await send('Page.navigate', { url: `${baseUrl}/chats` });
  await waitFor(`Boolean(document.querySelector('#root')?.childElementCount)`);
  await evaluate(setup);
  const waiting = await evaluate(`(async () => {
    await window.__approvalRuntime.create({ run: { id: '${runId}', chatId: 'approval-fixture', goal: '制作方案', status: 'active', generation: 0, planVersion: 1, updatedAt: Date.now() },
      tasks: [{ id: 'work', runId: '${runId}', kind: 'agent_text', input: '已确认的方案', dependsOn: [], status: 'queued', attempt: 0, updatedAt: Date.now() }] });
    const snapshot = await window.__approvalRuntime.resume('${runId}');
    return { status: snapshot.run.status, calls: window.__approvalCalls || 0 };
  })()`);
  assert.deepEqual(waiting, { status: 'paused', calls: 0 });
  await send('Page.reload');
  await waitFor(`Boolean(document.querySelector('#root')?.childElementCount)`);
  await evaluate(setup);
  await evaluate(`(async () => {
    const snapshot = await window.__approvalRuntime.resume('${runId}');
    if (snapshot.tasks[0].status !== 'waiting_user' || window.__approvalCalls) throw new Error('Refresh bypassed approval');
    const source = await (await fetch('/src/main.tsx')).text();
    const dependency = (name) => source.split('"').find((part) => part.startsWith('/node_modules/.vite/deps/' + name + '.js?'));
    const [react, dom, { default: Panel }] = await Promise.all([import(dependency('react')), import(dependency('react-dom_client')), import('/src/components/chat/TeamApprovalPanel.tsx')]);
    const React = react.default || react;
    window.__approvalRoot = (dom.createRoot || dom.default?.createRoot)(document.querySelector('#root'));
    window.__mountApproval = (run) => window.__approvalRoot.render(React.createElement(Panel, { run, task: run.tasks[0], disabled: false,
      onDecide: async (current, task, outcome) => {
        try {
          await window.__approvalRuntime.decideApproval(current.run.id, task.id, current.run.planVersion, outcome);
          window.__approvalResult = await window.__approvalRuntime.resume(current.run.id);
        } catch (error) { window.__approvalError = error.message; throw error; }
      } }));
    window.__mountApproval(snapshot);
  })()`);
  await waitFor(`Array.from(document.querySelectorAll('button')).some((button) => button.textContent === '批准本次执行')`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= 390`), true, 'Mobile panel must not overflow');
  await evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '批准本次执行').click()`);
  await waitFor(`Boolean(window.__approvalResult || window.__approvalError)`);
  const approved = await evaluate(`(async () => {
    if (window.__approvalError) throw new Error(window.__approvalError);
    await window.__approvalRuntime.resume('${runId}');
    return { status: window.__approvalResult.run.status, calls: window.__approvalCalls, decision: window.__approvalResult.tasks[0].approvals[0].decision.outcome };
  })()`);
  assert.deepEqual(approved, { status: 'completed', calls: 1, decision: 'approved' });
  await evaluate(`(async () => {
    const snapshot = await window.__approvalRuntime.read('${runId}');
    const id = '${runId}-reject';
    await window.__approvalRuntime.create({ run: { ...snapshot.run, id, status: 'active', planVersion: 1 },
      tasks: [{ id: 'work', runId: id, kind: 'agent_text', input: '另一方案', dependsOn: [], status: 'queued', attempt: 0, updatedAt: Date.now() }] });
    window.__approvalResult = null;
    window.__mountApproval(await window.__approvalRuntime.resume(id));
  })()`);
  await waitFor(`Array.from(document.querySelectorAll('button')).some((button) => button.textContent === '拒绝并停止任务组' && !button.disabled)`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '拒绝并停止任务组').click()`);
  await waitFor(`Boolean(window.__approvalResult || window.__approvalError)`);
  assert.deepEqual(await evaluate(`({ status: window.__approvalResult.run.status, calls: window.__approvalCalls })`), { status: 'cancelled', calls: 1 });
  console.log(JSON.stringify({ ok: true, refreshedWaiting: true, approvedOnce: true, rejectedWithoutDispatch: true, mobileWidth: 390 }));
} finally {
  await evaluate(`(async () => {
    window.__approvalRoot?.unmount();
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open('pneumata-workflow-runs'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const tx = database.transaction(Array.from(database.objectStoreNames), 'readwrite');
      const prefix = 'browser-approval-smoke' + String.fromCharCode(10) + '${runId}';
      for (const name of tx.objectStoreNames) tx.objectStore(name).delete(IDBKeyRange.bound(prefix, prefix + String.fromCharCode(65535)));
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    } finally { database.close(); }
  })()`);
  await send('Emulation.clearDeviceMetricsOverride');
  socket.close();
}
