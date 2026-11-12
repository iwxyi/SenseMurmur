import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const clientUrl = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5173';
const cdpUrl = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';
const fixtureDir = await mkdtemp(join(tmpdir(), 'pneumata-composition-'));
let socket;
try {
  // Native FFmpeg creates deterministic test inputs; production composition runs in Chromium WASM.
  const make = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 20_000 });
  make(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=0.6:r=24', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(fixtureDir, 'red.mp4')]);
  make(['-f', 'lavfi', '-i', 'color=c=blue:s=240x320:d=0.6:r=24', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=0.6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(fixtureDir, 'blue.mp4')]);
  make(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.3', join(fixtureDir, 'music.wav')]);
  const fixtures = {};
  for (const [id, name, mime] of [['shot_a', 'red.mp4', 'video/mp4'], ['shot_b', 'blue.mp4', 'video/mp4'], ['music', 'music.wav', 'audio/wav']]) {
    fixtures[id] = `data:${mime};base64,${(await readFile(join(fixtureDir, name))).toString('base64')}`;
  }
  const pages = await (await fetch(`${cdpUrl}/json/list`)).json();
  const page = pages.find((item) => item.type === 'page' && item.url.startsWith(new URL(clientUrl).origin));
  if (!page) throw new Error(`Open MirageTea in Chrome first: ${clientUrl}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data.toString());
    if (response.method === 'Runtime.consoleAPICalled' && response.params.type === 'error') console.error('Browser:', response.params.args.map((arg) => arg.value ?? arg.description));
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.error) entry.reject(new Error(response.error.message)); else entry.resolve(response.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.result?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `${clientUrl}/chats` });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(`Boolean(document.querySelector('#root')?.childElementCount)`)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await evaluate(`window.__compositionSmoke = { done: false }; void (async () => {
    const [{ useAuthStore }, { useChatStore }, { useMessageStore }, { createAgentTeamWorkflow }, runtime, composition, { validateAgentTeamPlan }] = await Promise.all([
      import('/src/stores/useAuthStore.ts'), import('/src/stores/useChatStore.ts'), import('/src/stores/useMessageStore.ts'),
      import('/src/services/agentTeamWorkflow.ts'), import('/src/services/workflowRunRuntime.ts'),
      import('/src/services/agentTeamMediaComposition.ts'), import('/src/services/agentTeamPlan.ts'),
    ]);
    localStorage.setItem('pneumata-auth-mode', 'local');
    localStorage.setItem('pneumata-cloud-sync-enabled', '0');
    useAuthStore.setState({ authMode: 'local', token: null, user: null, isLoggedIn: false, isLoading: false });
    await Promise.all([useChatStore.persist.hasHydrated() ? undefined : useChatStore.persist.rehydrate(), useMessageStore.persist.hasHydrated() ? undefined : useMessageStore.persist.rehydrate()]);
    const now = Date.now();
    const runId = 'composition-smoke-' + crypto.randomUUID();
    const chatId = 'composition-chat-' + crypto.randomUUID();
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', name: '本地合成实机验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null }] }));
    const fixtures = ${JSON.stringify(fixtures)};
    for (const [taskId, url] of Object.entries(fixtures)) useMessageStore.getState().upsertMessage({
      id: 'fixture-' + runId + taskId, chatId, type: 'ai', senderId: 'assistant', senderName: '助手', content: taskId,
      emotion: 0, timestamp: now, isDeleted: false, metadata: { agentTeamMedia: { runId, taskId }, attachments: [{
        id: 'fixture-' + taskId, kind: taskId === 'music' ? 'audio' : 'video', status: 'ready', altText: '测试素材', url, createdAt: now, updatedAt: now,
      }] },
    });
    const role = { id: 'director', name: '导演', responsibility: '制作短片', method: '拼接配乐', acceptance: '成片可用', allowedTools: ['video_generation', 'audio_generation', 'media_composition'] };
    const tasks = ['shot_a', 'shot_b', 'music'].map((id) => ({ id, roleId: role.id, goal: id, dependsOn: [], acceptance: '素材已保存', tool: id === 'music' ? 'audio_generation' : 'video_generation' }));
    tasks.push({ id: 'film', roleId: role.id, goal: '合并两镜头并循环配乐，关闭原声', dependsOn: ['shot_a', 'shot_b', 'music'], tool: 'media_composition', acceptance: '视频带音乐',
      composition: { clips: [{ taskId: 'shot_a', startSeconds: 0.1, durationSeconds: 0.4 }, { taskId: 'shot_b', durationSeconds: 0.4 }], audioTracks: [{ taskId: 'music', loop: true }], aspectRatio: '16:9', originalAudioVolume: 0 } });
    const plan = validateAgentTeamPlan({ summary: '合成验证', roles: [role], tasks, finalAcceptance: '视频带配乐' });
    const snapshot = { run: { id: runId, chatId, goal: '合成验证', status: 'paused', generation: 0, planVersion: 1, updatedAt: now, planOpen: true }, tasks: [
      { id: 'plan', runId, kind: 'team_plan', input: '合成验证', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
      ...plan.tasks.map((task) => ({ id: task.id, runId, kind: task.id === 'music' ? 'agent_audio' : task.id === 'film' ? 'agent_media_composition' : 'agent_video',
        input: { task, role: plan.roles[0], goal: '合成验证' }, output: task.id === 'film' ? undefined : '素材已保存', dependsOn: ['plan', ...task.dependsOn], status: task.id === 'film' ? 'running' : 'completed', attempt: 1, updatedAt: now })),
    ] };
    await runtime.indexedDbWorkflowRepository.transact(runtime.currentWorkflowScope(), runId, () => ({ snapshot, value: undefined }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', baseUrl: '', apiKey: '', model: 'not-called' }, runtime.currentWorkflowScope);
    const completed = await workflow.resume(runId);
    if (completed.snapshot.run.status !== 'completed') throw new Error('Workflow did not complete: ' + JSON.stringify(completed.snapshot.tasks));
    const attachment = composition.teamMediaAttachment(runId, 'film');
    if (!attachment?.url?.startsWith('data:video/mp4')) throw new Error('Composed file was not saved locally');
    const video = document.createElement('video'); video.muted = true; video.src = attachment.url;
    video.style.cssText = 'position:fixed;inset:80px auto auto 20px;width:640px;z-index:99999;background:black'; document.body.append(video);
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('Output video cannot decode')); });
    const sample = async (time) => {
      await new Promise((resolve) => { video.onseeked = resolve; video.currentTime = time; });
      const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
      const ctx = canvas.getContext('2d'); ctx.drawImage(video, video.videoWidth / 2, video.videoHeight / 2, 1, 1, 0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const firstPixel = await sample(0.15); const secondPixel = await sample(0.6);
    const audioContext = new OfflineAudioContext(1, 48000, 48000);
    const audio = await audioContext.decodeAudioData(await (await fetch(attachment.url)).arrayBuffer());
    const samples = audio.getChannelData(0);
    const energy = (hz) => {
      let real = 0, imag = 0;
      for (let index = Math.floor(audio.sampleRate * 0.45); index < Math.floor(audio.sampleRate * 0.7); index++) { real += samples[index] * Math.cos(2 * Math.PI * hz * index / audio.sampleRate); imag += samples[index] * Math.sin(2 * Math.PI * hz * index / audio.sampleRate); }
      return Math.hypot(real, imag);
    };
    const musicEnergy = energy(880), originalEnergy = energy(330);
    await workflow.resume(runId);
    const after = await workflow.read(runId);
    const state = useMessageStore.getState();
    const matches = new Set([...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)].filter((message) => message.id === 'team-composition-' + runId + '-film').map((message) => message.id));
    window.__compositionSmoke = { done: true, result: { status: after.run.status, width: video.videoWidth, height: video.videoHeight, duration: video.duration, firstPixel, secondPixel, musicEnergy, originalEnergy, messageCount: matches.size, attempt: after.tasks.find((task) => task.id === 'film').attempt, localUrl: attachment.url } };
  })().catch((error) => { window.__compositionSmoke = { done: true, error: String(error?.stack || error) }; });`);
  let result;
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const state = await evaluate(`({ ...window.__compositionSmoke, result: window.__compositionSmoke?.result ? { ...window.__compositionSmoke.result, localUrl: undefined } : undefined })`);
    if (state.done) { if (state.error) throw new Error(state.error); result = state.result; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(result, 'Composition exceeded three minutes');
  assert.equal(result.status, 'completed');
  assert.equal(result.width, 1280); assert.equal(result.height, 720);
  assert.ok(result.duration >= 0.75 && result.duration < 1.1);
  assert.ok(result.firstPixel[0] > 180 && result.firstPixel[2] < 40, 'First clip must remain red');
  assert.ok(result.secondPixel[2] > 180 && result.secondPixel[0] < 40, 'Second clip must remain blue');
  assert.ok(result.musicEnergy > 10 && result.musicEnergy > result.originalEnergy * 20, 'Music must loop into the second clip and original audio must be muted');
  assert.equal(result.messageCount, 1); assert.equal(result.attempt, 2);
  const outputUrl = await evaluate('window.__compositionSmoke.result.localUrl');
  const outputPath = process.env.PNEUMATA_COMPOSITION_OUTPUT;
  if (outputPath) await writeFile(outputPath, Buffer.from(outputUrl.split(',')[1], 'base64'));
  console.log(JSON.stringify({ ok: true, ...result, ...(outputPath ? { outputPath } : {}) }));
} finally {
  socket?.close();
  await rm(fixtureDir, { recursive: true, force: true });
}
