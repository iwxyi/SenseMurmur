import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const clientUrl = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5173';
const cdpUrl = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';
const stressComposition = process.env.PNEUMATA_COMPOSITION_STRESS === '1';
const fixtureDir = await mkdtemp(join(tmpdir(), 'pneumata-composition-'));
let socket;
try {
  // Native FFmpeg creates deterministic test inputs; production composition runs in Chromium WASM.
  const make = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 20_000 });
  make(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=0.6:r=24', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(fixtureDir, 'red.mp4')]);
  make(['-f', 'lavfi', '-i', 'color=c=blue:s=240x320:d=0.6:r=24', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=0.6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(fixtureDir, 'blue.mp4')]);
  make(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.3', join(fixtureDir, 'music.wav')]);
  make(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.3', join(fixtureDir, 'speech.wav')]);
  const speechFixture = (await readFile(join(fixtureDir, 'speech.wav'))).toString('base64');
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
    if (response.method === 'Runtime.consoleAPICalled' && response.params.type === 'error') {
      for (const arg of response.params.args) {
        if (!arg.objectId) { console.error('Browser:', arg.value ?? arg.description); continue; }
        void send('Runtime.callFunctionOn', { objectId: arg.objectId, functionDeclaration: 'function() { return JSON.stringify(this, (_key, value) => value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value); }', returnByValue: true })
          .then((result) => console.error('Browser:', result.result?.value))
          .catch((error) => console.error('Cannot inspect browser error:', error.message));
      }
    }
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
  const cleanup = `async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pneumata-workflow-runs', 6);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const tx = database.transaction(['runs', 'events', 'outbox', 'outbox_consumers', 'task_attempts', 'plan_revisions'], 'readwrite');
      for (const name of tx.objectStoreNames) {
        const request = tx.objectStore(name).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (String(cursor.key).includes(String.fromCharCode(10) + 'composition-smoke-')) cursor.delete();
          cursor.continue();
        };
      }
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    } finally { database.close(); }
  }`;
  await send('Page.enable');
  await send('Runtime.discardConsoleEntries');
  await send('Runtime.enable');
  await evaluate(`(${cleanup})()`);
  await send('Page.navigate', { url: `${clientUrl}/chats` });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(`Boolean(document.querySelector('#root')?.childElementCount)`)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await evaluate(`window.__compositionSmoke = { done: false }; void (async () => {
    const [{ useAuthStore }, { useChatStore }, { useMessageStore }, { useSettingsStore }, { createAgentTeamWorkflow }, runtime, composition, { validateAgentTeamPlan }, { defaultWorkflowGoalSpec }] = await Promise.all([
      import('/src/stores/useAuthStore.ts'), import('/src/stores/useChatStore.ts'), import('/src/stores/useMessageStore.ts'),
      import('/src/stores/useSettingsStore.ts'),
      import('/src/services/agentTeamWorkflow.ts'), import('/src/services/workflowRunRuntime.ts'),
      import('/src/services/agentTeamMediaComposition.ts'), import('/src/services/agentTeamPlan.ts'),
      import('/src/services/workflowGoalSpec.ts'),
    ]);
    localStorage.setItem('pneumata-auth-mode', 'local');
    localStorage.setItem('pneumata-cloud-sync-enabled', '0');
    useAuthStore.setState({ authMode: 'local', token: null, user: null, isLoggedIn: false, isLoading: false });
    await Promise.all([useChatStore.persist.hasHydrated() ? undefined : useChatStore.persist.rehydrate(), useMessageStore.persist.hasHydrated() ? undefined : useMessageStore.persist.rehydrate()]);
    if (!useSettingsStore.persist.hasHydrated()) await useSettingsStore.persist.rehydrate();
    const now = Date.now();
    const runId = 'composition-smoke-' + crypto.randomUUID();
    const chatId = 'composition-chat-' + crypto.randomUUID();
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', name: '本地合成实机验证', memberIds: [], createdAt: now, updatedAt: now, deletedAt: null }] }));
    const fixtures = ${JSON.stringify(fixtures)};
    for (const [taskId, url] of Object.entries(fixtures)) useMessageStore.getState().upsertMessage({
      id: 'fixture-' + runId + taskId, chatId, type: 'ai', senderId: 'assistant', senderName: '助手', content: taskId,
      emotion: 0, timestamp: now, isDeleted: false, metadata: { agentTeamMedia: { runId, taskId: taskId + '_source' }, attachments: [{
        id: 'fixture-' + taskId, kind: taskId === 'music' ? 'audio' : 'video', status: 'ready', altText: '测试素材', url, createdAt: now, updatedAt: now,
      }] },
    });
    const imageCanvas = document.createElement('canvas'); imageCanvas.width = 32; imageCanvas.height = 32;
    imageCanvas.getContext('2d').fillStyle = '#00ff00'; imageCanvas.getContext('2d').fillRect(0, 0, 32, 32);
    const imageFixture = imageCanvas.toDataURL('image/png');
    useMessageStore.getState().upsertMessage({ id: 'image-fixture-' + runId, chatId, type: 'ai', senderId: 'assistant', senderName: '助手', content: '场景素材',
      emotion: 0, timestamp: now, isDeleted: false, metadata: { agentTeamMedia: { runId, taskId: 'frame' }, attachments: [{ id: 'frame', kind: 'image', status: 'ready', altText: '绿色场景', url: imageFixture, mimeType: 'image/png', createdAt: now, updatedAt: now }] } });
    const role = { id: 'director', name: '导演', responsibility: '制作短片', method: '拼接配乐', acceptance: '成片可用', allowedTools: ['delegate_task', 'text_generation', 'speech_generation', 'image_generation', 'image_inspection', 'video_generation', 'audio_generation', 'media_composition', 'video_inspection'] };
    const tasks = ['shot_a', 'shot_b', 'music'].map((id) => ({ id, roleId: role.id, goal: id, dependsOn: [], acceptance: '素材已保存', tool: 'delegate_task', mediaOutput: id === 'music' ? 'audio' : 'video' }));
    tasks.push({ id: 'script', roleId: role.id, goal: '只写旁白正文', dependsOn: [], acceptance: '有正文', tool: 'text_generation' });
    tasks.push({ id: 'frame', roleId: role.id, goal: '绿色场景', dependsOn: [], acceptance: '有图片', tool: 'image_generation' });
    tasks.push({ id: 'narration', roleId: role.id, goal: '制作旁白，不朗读这条指令', dependsOn: ['script'], acceptance: '旁白可播放', tool: 'speech_generation', speech: { textTaskId: 'script' } });
    tasks.push({ id: 'film', roleId: role.id, goal: '合并两镜头并循环配乐，叠加旁白，关闭原声', dependsOn: ['shot_a', 'shot_b', 'music', 'narration'], tool: 'media_composition', acceptance: '视频带音乐与旁白',
      composition: { clips: [{ taskId: 'shot_a', startSeconds: 0.1, durationSeconds: 0.4 }, { taskId: 'shot_b', durationSeconds: 0.4 }], audioTracks: [{ taskId: 'music', loop: true }, { taskId: 'narration', volume: 0.5, offsetSeconds: 0.4 }], aspectRatio: '16:9', originalAudioVolume: 0 } });
    tasks.push({ id: 'inspect', roleId: role.id, goal: '检查成片颜色顺序', dependsOn: ['film'], tool: 'video_inspection', acceptance: '红色在前蓝色在后' });
    const plan = validateAgentTeamPlan({ summary: '合成验证', roles: [role], tasks, finalAcceptance: '视频带配乐' });
    const goalSpec = defaultWorkflowGoalSpec('合成验证');
    goalSpec.constraints = ['保留红蓝镜头顺序'];
    goalSpec.acceptance = ['成片同时包含配乐和旁白'];
    goalSpec.allowedTools = [...role.allowedTools];
    const snapshot = { run: { id: runId, chatId, goal: '合成验证', goalSpec, status: 'paused', generation: 0, planVersion: 1, updatedAt: now, planOpen: true }, tasks: [
      { id: 'plan', runId, kind: 'team_plan', input: '合成验证', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
      ...plan.tasks.map((task) => ({ id: task.id, runId, kind: task.tool === 'delegate_task' ? 'agent_delegation' : task.id === 'frame' ? 'agent_image' : task.id === 'narration' ? 'agent_audio' : task.id === 'script' ? 'agent_text' : task.id === 'film' ? 'agent_media_composition' : 'agent_video_inspection',
        input: { task, role: plan.roles[0], goal: '合成验证' }, output: ['film', 'narration', 'inspect'].includes(task.id) ? undefined : task.id === 'script' ? '森林深处，一场追逐开始了。' : '素材已保存', dependsOn: ['plan', ...task.dependsOn], status: task.id === 'film' ? 'running' : ['narration', 'inspect'].includes(task.id) ? 'waiting_dependency' : 'completed', attempt: ['narration', 'inspect'].includes(task.id) ? 0 : 1, updatedAt: now })),
    ] };
    for (const parent of snapshot.tasks.filter((task) => task.kind === 'agent_delegation')) {
      const tool = parent.input.task.mediaOutput === 'audio' ? 'audio_generation' : 'video_generation';
      const childPlan = validateAgentTeamPlan({ summary: '下级素材交付', roles: [{ ...role, allowedTools: [tool] }],
        tasks: [{ id: 'source', roleId: role.id, tool, goal: parent.id, dependsOn: [], acceptance: '素材已保存' }], resultTaskId: 'source', finalAcceptance: '素材可用' });
      const childId = parent.id + '_source';
      parent.expansion = { taskIds: [childId], context: childPlan };
      parent.dependsOn.push(childId);
      snapshot.tasks.push({ id: childId, runId, kind: tool === 'audio_generation' ? 'agent_audio' : 'agent_video',
        input: { task: childPlan.tasks[0], role: childPlan.roles[0], goal: '合成验证', sourcePlanTaskId: parent.id },
        output: '素材已保存', dependsOn: [], status: 'completed', attempt: 1, updatedAt: now });
    }
    await runtime.indexedDbWorkflowRepository.transact(runtime.currentWorkflowScope(), runId, () => ({ snapshot, value: undefined }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', baseUrl: '', apiKey: '', model: 'not-called' }, runtime.currentWorkflowScope);
    const originalFetch = window.fetch;
    const originalProfiles = useSettingsStore.getState().aiProfiles;
    let speechRequests = 0;
    let visionRequests = 0;
    let imageChecks = 0;
    let inspectionPixels;
    let revisionRequests = 0;
    let revisionPlan;
    let stagnationResponses;
    let stagnationRequests = 0;
    useSettingsStore.setState({ aiProfiles: [
      { id: 'speech-smoke', name: '测试旁白', type: 'tts', provider: 'openai', baseUrl: 'https://speech-smoke.invalid/v1', apiKey: 'test-fixture', model: 'tts-1', isDefault: true },
      { id: 'vision-smoke', name: '测试视觉', type: 'text', provider: 'openai', baseUrl: 'https://vision-smoke.invalid/v1', apiKey: 'test-fixture', model: 'gpt-4o', isDefault: true },
    ] });
    window.fetch = async (input, init) => {
      if (String(input).startsWith('https://stagnation-smoke.invalid/')) {
        const body = JSON.parse(init.body);
        stagnationRequests++;
        if (stagnationResponses.length === 1) {
          const prompt = JSON.stringify(body.messages);
          if (!prompt.includes('observationScope') || !prompt.includes('不证明音轨')) throw new Error('Media comparison lost its observation scope');
        }
        const content = stagnationResponses.shift();
        if (!content) throw new Error('Unexpected repeated stagnation request');
        return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      }
      if (String(input).startsWith('https://revision-smoke.invalid/')) {
        const body = JSON.parse(init.body);
        if (!JSON.stringify(body.messages).includes('可复用历史素材目录') || !revisionPlan || revisionRequests++) throw new Error('Invalid or duplicate revision planning request');
        return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(revisionPlan) }, finish_reason: 'stop' }] });
      }
      if (String(input).startsWith('https://vision-smoke.invalid/')) {
        const body = JSON.parse(init.body);
        const content = body.messages.at(-1).content;
        const images = content.filter((item) => item.type === 'image_url');
        if (images.length === 1) {
          if (images[0].image_url.url !== imageFixture) throw new Error('Historical image bytes changed or missing');
          imageChecks++;
          return Response.json({ choices: [{ message: { role: 'assistant', content: '实际图片为绿色场景。' }, finish_reason: 'stop' }] });
        }
        if (images.length !== 6 || !content.some((item) => item.type === 'text' && item.text.includes('未检查音轨'))) throw new Error('Missing video frames or inspection scope');
        inspectionPixels = await Promise.all([images[0], images.at(-1)].map(async (item) => {
          if (!item.image_url.url.startsWith('data:image/jpeg;base64,')) throw new Error('Inspection did not receive real JPEG frames');
          const image = new Image(); image.src = item.image_url.url; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
          const context = canvas.getContext('2d'); context.drawImage(image, image.width / 2, image.height / 2, 1, 1, 0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
        }));
        visionRequests++;
        return Response.json({ choices: [{ message: { role: 'assistant', content: '抽样画面先红后蓝；未检查音轨与逐帧连续性。' }, finish_reason: 'stop' }] });
      }
      if (!String(input).startsWith('https://speech-smoke.invalid/')) return originalFetch(input, init);
      const body = JSON.parse(init.body);
      if (body.input !== '森林深处，一场追逐开始了。' || body.voice !== 'alloy' || body.model !== 'tts-1') throw new Error('Incorrect speech request: ' + JSON.stringify(body));
      speechRequests++;
      return new Response(Uint8Array.from(atob(${JSON.stringify(speechFixture)}), (char) => char.charCodeAt(0)), { headers: { 'Content-Type': 'audio/wav' } });
    };
    try {
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
    const musicEnergy = energy(880), originalEnergy = energy(330), narrationEnergy = energy(660);
    const recoveredWorkflow = createAgentTeamWorkflow({ provider: 'openai', baseUrl: '', apiKey: '', model: 'not-called' }, runtime.currentWorkflowScope);
    await recoveredWorkflow.resume(runId);
    const after = await workflow.read(runId);
    if (JSON.stringify(after.run.goalSpec) !== JSON.stringify(goalSpec)) throw new Error('Goal contract changed during recovery');
    let rejectedGoalReplacement = false;
    try {
      await runtime.indexedDbWorkflowRepository.transact(runtime.currentWorkflowScope(), runId, (current) => {
        current.run.goalSpec.allowedTools = [];
        return { snapshot: current, value: undefined };
      });
    } catch (error) {
      if (!String(error).includes('目标契约不能在执行中替换')) throw error;
      rejectedGoalReplacement = true;
    }
    if (!rejectedGoalReplacement) throw new Error('Goal authorization replacement was accepted');
    const persisted = await recoveredWorkflow.read(runId);
    if (JSON.stringify(persisted.run.goalSpec) !== JSON.stringify(goalSpec)) throw new Error('Rejected goal mutation did not roll back');
    const state = useMessageStore.getState();
    const matches = new Set([...state.messages, ...Object.values(state.messageWindowsByChatId).flatMap((window) => window.messages)].filter((message) => message.id === 'team-composition-' + runId + '-film').map((message) => message.id));
    const narration = composition.teamMediaAttachment(runId, 'narration');
    if (!narration?.url?.startsWith('data:audio/') || narration.audioPurpose !== 'chat_voice') throw new Error('Narration not saved locally');
    const inspection = after.tasks.find((task) => task.id === 'inspect');
    if (inspection.status !== 'completed' || !inspection.output.includes('未检查音轨或逐帧连续性')) throw new Error('Missing persisted inspection scope');
    const inspectionAttempts = await runtime.indexedDbWorkflowRepository.listTaskAttempts(runtime.currentWorkflowScope(), runId, 'inspect');
    const { workflowJsonDigest } = await import('/src/services/workflowToolRequest.ts');
    if (inspection.modelInvocation?.state !== 'succeeded' || inspectionAttempts.length !== 1
      || workflowJsonDigest(inspectionAttempts[0].modelInvocation) !== workflowJsonDigest(inspection.modelInvocation)
      || !/^[a-f0-9]{64}$/.test(inspection.modelInvocation.request?.sha256 || '')) throw new Error('Missing atomic model invocation journal');
    const { listTeamSavedMedia } = await import('/src/services/agentTeamSavedMedia.ts');
    const savedMedia = listTeamSavedMedia(after, ['shot_a', 'shot_b', 'music', 'narration']).map((source) => ({ ...source, alias: 'old_' + source.taskId }));
    const savedFilm = listTeamSavedMedia(after, ['film']).map((source) => ({ ...source, alias: 'old_film' }));
    const savedFrame = listTeamSavedMedia(after, ['frame']).map((source) => ({ ...source, alias: 'old_frame' }));
    const revisedClips = ${stressComposition} ? Array.from({ length: 40 }, (_, index) => ({ taskId: index % 2 ? 'old_shot_b' : 'old_shot_a', durationSeconds: 0.4 }))
      : [{ taskId: 'old_shot_a', startSeconds: 0.1, durationSeconds: 0.4 }, { taskId: 'old_shot_b', durationSeconds: 0.4 }];
    revisionPlan = { summary: '复用已有素材制作竖屏版并复查原片', roles: [{ ...role, allowedTools: ['media_composition', 'video_inspection', 'image_inspection'] }], finalAcceptance: '竖屏版有配乐和旁白',
      tasks: [{ id: 'portrait', roleId: role.id, goal: '复用已有素材制作竖屏版本', acceptance: '顺序不变且有伴奏旁白', dependsOn: [], tool: 'media_composition', savedMedia,
        composition: { clips: revisedClips,
          audioTracks: [{ taskId: 'old_music', loop: true }, { taskId: 'old_narration', volume: 0.5, offsetSeconds: 0.4 }], aspectRatio: '9:16', originalAudioVolume: 0 } },
        { id: 'reinspect', roleId: role.id, goal: '复查历史成片的镜头顺序', acceptance: '先红后蓝', dependsOn: [], tool: 'video_inspection', savedMedia: savedFilm },
        { id: 'check_frame', roleId: role.id, goal: '检查历史场景图', acceptance: '绿色场景', dependsOn: [], tool: 'image_inspection', savedMedia: savedFrame }] };
    const revisionConfig = { provider: 'openai', baseUrl: 'https://revision-smoke.invalid/v1', apiKey: 'test-fixture', model: 'fixture' };
    const revisionWorkflow = createAgentTeamWorkflow(revisionConfig, runtime.currentWorkflowScope);
    await revisionWorkflow.addRevisionRequest(runId, after.run.planVersion, '请复用已生成的全部素材制作竖屏版，不重新生成或配音');
    const revised = await createAgentTeamWorkflow(revisionConfig, runtime.currentWorkflowScope).resume(runId);
    if (revised.snapshot.run.status !== 'completed') throw new Error('Saved media revision failed: ' + JSON.stringify(revised.snapshot.tasks));
    if (revised.snapshot.tasks.find((task) => task.id === 'delegated_reinspect')?.status !== 'completed') throw new Error('Historical video inspection missing');
    if (revised.snapshot.tasks.find((task) => task.id === 'delegated_check_frame')?.status !== 'completed') throw new Error('Historical image inspection missing');
    const portrait = composition.teamMediaAttachment(runId, 'delegated_portrait');
    if (!portrait?.url) throw new Error('Revised composition missing');
    const portraitVideo = document.createElement('video'); portraitVideo.muted = true; portraitVideo.src = portrait.url;
    await new Promise((resolve, reject) => { portraitVideo.onloadedmetadata = resolve; portraitVideo.onerror = () => reject(new Error('Revised video cannot decode')); });
    const revisedPixels = [];
    if (${stressComposition}) {
      for (let index = 0; index < 40; index++) {
        await new Promise((resolve) => { portraitVideo.onseeked = resolve; portraitVideo.currentTime = index * 0.4 + 0.2; });
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
        const context = canvas.getContext('2d'); context.drawImage(portraitVideo, portraitVideo.videoWidth / 2, portraitVideo.videoHeight / 2, 1, 1, 0, 0, 1, 1);
        const pixel = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
        revisedPixels.push(pixel);
        if (!(index % 2 ? pixel[2] > 180 && pixel[0] < 40 : pixel[0] > 180 && pixel[2] < 40)) throw new Error('Forty-clip timeline drift at clip ' + index + ': ' + JSON.stringify({ pixel, duration: portraitVideo.duration }));
      }
    }
    await createAgentTeamWorkflow(revisionConfig, runtime.currentWorkflowScope).resume(runId);
    const portraitAttempts = await runtime.indexedDbWorkflowRepository.listTaskAttempts(runtime.currentWorkflowScope(), runId, 'delegated_portrait');
    const portraitMessages = useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.filter((message) => message.id === 'team-composition-' + runId + '-delegated_portrait') || [];
    if (portraitAttempts.length !== 1 || portraitMessages.length !== 1 || revisionRequests !== 1 || speechRequests !== 1 || visionRequests !== 2 || imageChecks !== 1) throw new Error('Saved media revision duplicated work');
    const mediaStagnation = [];
    for (const kind of ['image', 'video']) {
      const stalledId = runId + '-stalled-' + kind;
      const inspectionTool = kind + '_inspection';
      const source = { id: 'source', roleId: role.id, tool: kind + '_generation', goal: '蓝色画面', acceptance: '画面全蓝', dependsOn: [] };
      const check = { id: 'check', roleId: role.id, tool: inspectionTool, goal: '检查是否全蓝', acceptance: '画面全蓝', dependsOn: ['source'] };
      const stalledPlan = validateAgentTeamPlan({ summary: '核对颜色', roles: [role], tasks: [source, check], finalAcceptance: '所有画面全蓝' });
      const stalledSnapshot = { run: { id: stalledId, chatId, goal: '所有画面全蓝', goalSpec: defaultWorkflowGoalSpec('所有画面全蓝'), status: 'paused', generation: 0, planVersion: 1, updatedAt: now, planOpen: true, autoReview: true }, tasks: [
        { id: 'plan', runId: stalledId, kind: 'team_plan', input: '所有画面全蓝', output: stalledPlan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'source', runId: stalledId, kind: 'agent_' + kind, input: { task: source, role, goal: '所有画面全蓝' }, output: '素材已保存', dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'check', runId: stalledId, kind: 'agent_' + inspectionTool, input: { task: check, role, goal: '所有画面全蓝' }, dependsOn: ['plan', 'source'], status: 'queued', attempt: 0, updatedAt: now },
      ] };
      stalledSnapshot.run.goalSpec.allowedTools = [...role.allowedTools];
      useMessageStore.getState().upsertMessage({ id: 'fixture-' + stalledId, chatId, type: 'ai', senderId: 'assistant', senderName: '助手', content: '测试素材', emotion: 0, timestamp: now, isDeleted: false,
        metadata: { agentTeamMedia: { runId: stalledId, taskId: 'source' }, attachments: [{ id: 'source', kind, status: 'ready', altText: '颜色检查素材', url: kind === 'image' ? imageFixture : attachment.url, mimeType: kind === 'image' ? 'image/png' : 'video/mp4', createdAt: now, updatedAt: now }] } });
      await runtime.indexedDbWorkflowRepository.transact(runtime.currentWorkflowScope(), stalledId, () => ({ snapshot: stalledSnapshot, value: undefined }));
      const saved = listTeamSavedMedia(stalledSnapshot, ['source']).map((item) => ({ ...item, alias: 'original' }));
      stagnationResponses = [
        JSON.stringify({ complete: false, reason: '实际画面并非全蓝', nextRequest: '复查已有素材确认颜色缺陷' }),
        JSON.stringify({ summary: '复查', roles: [role], tasks: [{ id: 'recheck', roleId: role.id, tool: inspectionTool, goal: '复查颜色缺陷', acceptance: '画面全蓝', dependsOn: [], savedMedia: saved }], finalAcceptance: '所有画面全蓝' }),
        JSON.stringify({ complete: false, reason: '相同颜色缺陷仍存在', nextRequest: '更换素材', progress: { status: 'stalled', reason: '两次实际检查的颜色缺陷没有改善' } }),
      ];
      const config = { provider: 'openai', baseUrl: 'https://stagnation-smoke.invalid/v1', apiKey: 'test-fixture', model: 'gpt-4o' };
      const stalled = await createAgentTeamWorkflow(config, runtime.currentWorkflowScope).resume(stalledId);
      if (stalled.snapshot.run.status !== 'paused') throw new Error('Media stagnation did not pause: ' + JSON.stringify(stalled.snapshot.tasks));
      const reviews = stalled.snapshot.tasks.filter((task) => task.kind === 'team_review').map((task) => task.output);
      if (reviews.length !== 2 || reviews[1].progress?.status !== 'stalled') throw new Error('Missing persisted media progress assessment');
      const counts = [stagnationRequests, imageChecks, visionRequests];
      await createAgentTeamWorkflow(config, runtime.currentWorkflowScope).resume(stalledId);
      const restored = await runtime.indexedDbWorkflowRepository.read(runtime.currentWorkflowScope(), stalledId);
      if (JSON.stringify(counts) !== JSON.stringify([stagnationRequests, imageChecks, visionRequests])
        || JSON.stringify(reviews) !== JSON.stringify(restored.tasks.filter((task) => task.kind === 'team_review').map((task) => task.output))) throw new Error('Media stagnation recovery repeated or changed inspection');
      mediaStagnation.push({ kind, status: restored.run.status, reviewCount: reviews.length });
    }
    window.__compositionSmoke = { done: true, result: { status: after.run.status, mediaStagnation, stagnationRequests, stressClipsChecked: revisedPixels.length, savedMediaRevision: { width: portraitVideo.videoWidth, height: portraitVideo.videoHeight, revisionRequests, attempts: portraitAttempts.length, messageCount: portraitMessages.length }, rejectedGoalReplacement, width: video.videoWidth, height: video.videoHeight, duration: video.duration, firstPixel, secondPixel, musicEnergy, originalEnergy, narrationEnergy, speechRequests, visionRequests, imageChecks, inspectionPixels, messageCount: matches.size, attempt: after.tasks.find((task) => task.id === 'film').attempt, localUrl: attachment.url } };
    } finally { window.fetch = originalFetch; useSettingsStore.setState({ aiProfiles: originalProfiles }); }
  })().catch((error) => { window.__compositionSmoke = { done: true, error: String(error?.stack || error) }; });`);
  let result;
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const state = await evaluate(`({ ...window.__compositionSmoke, result: window.__compositionSmoke?.result ? { ...window.__compositionSmoke.result, localUrl: undefined } : undefined })`);
    if (state.done) { if (state.error) throw new Error(state.error); result = state.result; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(result, 'Composition exceeded three minutes');
  assert.equal(result.status, 'completed');
  assert.equal(result.stressClipsChecked, stressComposition ? 40 : 0);
  assert.deepEqual(result.savedMediaRevision, { width: 720, height: 1280, revisionRequests: 1, attempts: 1, messageCount: 1 });
  assert.equal(result.rejectedGoalReplacement, true);
  assert.equal(result.width, 1280); assert.equal(result.height, 720);
  assert.ok(result.duration >= 0.75 && result.duration < 1.1);
  assert.ok(result.firstPixel[0] > 180 && result.firstPixel[2] < 40, 'First clip must remain red');
  assert.ok(result.secondPixel[2] > 180 && result.secondPixel[0] < 40, 'Second clip must remain blue');
  assert.ok(result.musicEnergy > 10 && result.musicEnergy > result.originalEnergy * 20, 'Music must loop into the second clip and original audio must be muted');
  assert.ok(result.narrationEnergy > 10 && result.narrationEnergy > result.originalEnergy * 10, 'Narration must be mixed into the second clip');
  assert.equal(result.speechRequests, 1, 'Recreating the workflow must not synthesize narration twice');
  assert.equal(result.visionRequests, 4, 'Each planned inspection must run once across recovery');
  assert.equal(result.imageChecks, 3, 'Saved images must be inspected once per step without an image generation model');
  assert.equal(result.stagnationRequests, 6);
  assert.deepEqual(result.mediaStagnation, ['image', 'video'].map((kind) => ({ kind, status: 'paused', reviewCount: 2 })));
  assert.ok(result.inspectionPixels[0][0] > 180 && result.inspectionPixels[0][2] < 40, 'Inspection must receive the actual red opening frame');
  assert.ok(result.inspectionPixels[1][2] > 180 && result.inspectionPixels[1][0] < 40, 'Inspection must receive the actual blue ending frame');
  assert.equal(result.messageCount, 1); assert.equal(result.attempt, 2);
  const outputUrl = await evaluate('window.__compositionSmoke.result.localUrl');
  const outputPath = process.env.PNEUMATA_COMPOSITION_OUTPUT;
  if (outputPath) await writeFile(outputPath, Buffer.from(outputUrl.split(',')[1], 'base64'));
  await evaluate(`(${cleanup})()`);
  console.log(JSON.stringify({ ok: true, ...result, ...(outputPath ? { outputPath } : {}) }));
} finally {
  socket?.close();
  await rm(fixtureDir, { recursive: true, force: true });
}
