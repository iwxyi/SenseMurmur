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
    const [reactModule, reactDomClient, { default: Workbench }] = await Promise.all([
      import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'), import('/src/components/chat/AssistantTeamWorkbench.tsx'),
    ]);
    const React = reactModule.default || reactModule;
    const createRoot = reactDomClient.createRoot || reactDomClient.default?.createRoot;
    const now = Date.now();
    const runId = 'browser-collab-run';
    const plan = { summary: '市场研究', roles: [{ id: 'analyst', name: '市场分析师', responsibility: '分析市场竞争', method: '比较公开资料', acceptance: '结论注明来源' }], tasks: [{ id: 'research', roleId: 'analyst', goal: '研究市场竞争', dependsOn: [], acceptance: '结论注明来源', tool: 'text_generation' }], finalAcceptance: '结论可复核' };
    const run = { run: { id: runId, chatId: 'browser-collab-chat', goal: '研究市场机会', status: 'completed', generation: 1, planVersion: 2, updatedAt: now }, tasks: [
      { id: 'plan', runId, kind: 'team_plan', input: '研究市场机会', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
      { id: 'research', runId, kind: 'agent_text', input: { task: plan.tasks[0], role: plan.roles[0], goal: '研究市场机会' }, output: '主要竞争者采用订阅模式', dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: now },
    ] };
    const container = document.createElement('div');
    container.id = 'assistant-team-smoke-root';
    document.body.append(container);
    window.__assistantTeamSmoke = { calls: [] };
    const root = createRoot(container);
    window.__assistantTeamSmoke.root = root;
    root.render(React.createElement(Workbench, {
      runs: [run], canRun: true, isRunActive: () => false, onResume: () => {}, onCreate: () => {},
      onInstruct: async () => {}, onPause: async () => {},
      onDelegate: async (...args) => { window.__assistantTeamSmoke.calls.push(args); },
      onAbandonReview: async () => {}, onResumeAfterReviewRetry: async () => {}, onResumeAfterPlanRetry: async () => {},
    }));
    return true;
  })()`);
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('#assistant-team-smoke-root button')).some((button) => button.textContent?.includes('工作台'))`), 'workbench mounted');
  await cdp.evaluate(`Array.from(document.querySelectorAll('#assistant-team-smoke-root button')).find((button) => button.textContent?.includes('工作台')).click()`);
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).some((button) => button.textContent?.includes('市场分析师'))`), 'child agent selector');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find((button) => button.textContent?.includes('市场分析师')).click()`);
  await waitFor(() => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll('[role="dialog"] label')).find((label) => label.textContent?.includes('与该子 Agent 继续协作')))`), 'child instruction input');
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[role="dialog"] textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '补充日本市场，并标注数据年份');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent?.includes('发送给主 Agent')).click()`);
  await waitFor(() => cdp.evaluate(`window.__assistantTeamSmoke?.calls.length === 1`), 'revision request submitted');
  const request = await cdp.evaluate(`window.__assistantTeamSmoke.calls[0][1]`);
  assert.match(request, /市场分析师/);
  assert.match(request, /原任务：研究市场竞争/);
  assert.match(request, /补充日本市场，并标注数据年份/);
  console.log(JSON.stringify({ ok: true, childRole: '市场分析师', revisionRequest: request }));
} finally {
  await cdp.evaluate(`window.__assistantTeamSmoke?.root?.unmount(); document.querySelector('#assistant-team-smoke-root')?.remove();`).catch(() => undefined);
  cdp.close();
}
