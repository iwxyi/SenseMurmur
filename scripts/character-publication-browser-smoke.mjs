import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const clientUrl = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5173';
const cdpUrl = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';
const reportDir = process.env.PUBLICATION_REPORT_DIR || '/tmp/miragetea-publication-smoke';
const profile = {
  id: 'publication-smoke-text', name: 'Smoke text', type: 'text', isDefault: true,
  provider: process.env.PUBLICATION_LLM_PROVIDER || 'google',
  apiKey: process.env.PUBLICATION_LLM_API_KEY || process.env.GEMINI_API_KEY,
  baseUrl: process.env.PUBLICATION_LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
  model: process.env.PUBLICATION_LLM_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  maxOutputTokens: 8192,
};
assert(profile.apiKey, 'Set PUBLICATION_LLM_API_KEY or GEMINI_API_KEY');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.pending = new Map(); this.nextId = 0; }
  async open() {
    await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); });
    this.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 180_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  page(method, params = {}) { return this.send(method, params, this.sessionId); }
  async evaluate(expression) {
    const result = await this.page('Runtime.evaluate', { expression: `window.__publicationPromise = (${expression})`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
}
const snapshot = `(() => {
  const { artifacts, chats, characters, projectWorldMoments } = window.__publication;
  return { now: Date.now(), jobs: artifacts.getState().jobs.map(({ kind, status, readyAt, error }) => ({ kind, status, readyAt, error })),
    items: artifacts.getState().items.map(({ kind, characterId, dateKey, text }) => ({ kind, characterId, dateKey, text })),
    decisions: Object.keys(artifacts.getState().diaryDecisions || {}),
    moments: projectWorldMoments(chats.getState().chats, characters.getState().characters).filter((item) => item.kind === 'post_moment').map(({ actorId, text, createdAt }) => ({ actorId, text, createdAt })) };
})()`;
const version = await fetch(`${cdpUrl}/json/version`).then((response) => response.json());
const cdp = new Cdp(version.webSocketDebuggerUrl);
const report = { model: profile.model, isolatedBrowserContext: true, realLLM: true, virtualClock: true };
let browserContextId;
try {
  await mkdir(reportDir, { recursive: true });
  await cdp.open();
  ({ browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true }));
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  ({ sessionId: cdp.sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await cdp.page('Runtime.enable'); await cdp.page('Page.enable');
  await cdp.page('Page.navigate', { url: `${clientUrl}/moments` });
  for (let index = 0; index < 120; index++) {
    if (await cdp.evaluate('Boolean(document.querySelector("main"))')) break;
    await wait(500);
  }
  assert(await cdp.evaluate('Boolean(document.querySelector("main"))'), 'Application did not render');
  await cdp.evaluate(`(async () => {
    const load = (path) => import(performance.getEntriesByType('resource').filter((entry) => new URL(entry.name).pathname === path).at(-1)?.name || path);
    const [{ useChatStore: chats }, { useCharacterStore: characters }, { useSettingsStore: settings },
      { useCharacterArtifactStore: artifacts, ensureCharacterArtifactStoreHydrated }, { normalizeCharacter }, { normalizeConversation },
      { setCloudSyncEnabled }, { setAIGenerationRuntimeConfig }, { projectWorldMoments }] = await Promise.all([
      load('/src/stores/useChatStore.ts'), load('/src/stores/useCharacterStore.ts'), load('/src/stores/useSettingsStore.ts'),
      load('/src/stores/useCharacterArtifactStore.ts'), load('/src/types/character.ts'), load('/src/types/chat.ts'),
      load('/src/services/cloudSyncPreference.ts'), load('/src/services/aiGenerationRuntimeConfig.ts'), load('/src/services/worldRuntimeProjection.ts')]);
    await Promise.all([chats.persist.rehydrate(), characters.persist.rehydrate(), settings.persist.rehydrate(), ensureCharacterArtifactStoreHydrated()]);
    const NativeDate = Date;
    let offset = new NativeDate(2026, 9, 16, 14).getTime() - NativeDate.now();
    window.__publicationJump = (ms) => { offset += ms; };
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [NativeDate.now() + offset])); }
      static now() { return NativeDate.now() + offset; }
    };
    setCloudSyncEnabled(false);
    settings.setState((state) => ({ aiProfiles: [${JSON.stringify(profile)}], language: 'zh', aiGeneration: { ...state.aiGeneration, enableMoments: true, enableDiaries: true } }));
    setAIGenerationRuntimeConfig({ enableMoments: true, enableDiaries: true });
    const now = Date.now();
    const memory = (id, text) => ({ id: 'memory-' + id, ownerId: id, subjectIds: [id], scope: 'character_self', layer: 'episodic', kind: 'bond',
      text, visibility: 'public_safe', validity: 'active', salience: 0.9, confidence: 0.95, recency: 1, reinforcementCount: 1,
      sourceEventIds: [], privacyRisk: 0, createdAt: now - 3 * 3600000, updatedAt: now - 3 * 3600000 });
    const actor = (id, name, text, isPreset) => normalizeCharacter({ id, name, avatar: '', isPreset,
      background: '普通大学生，喜欢跑步，生活平静。只写真实发生的事。', speakingStyle: '简短自然，不喜欢空泛煽情。', expertise: ['跑步'],
      generationPreferences: { moments: 'on', diaries: 'on' }, layeredMemories: [memory(id, text)], createdAt: now, updatedAt: now });
    const actors = [actor('smoke-ordinary', '小平', '今天群里互相问好，说了早安和收到，然后各自去忙。没有其他事情，没有情绪变化。', true),
      actor('smoke-milestone-b', '小程', '今天人生第一次完成全程马拉松，用时4小时18分。曾经因腿伤差点放弃，恢复训练一年终于冲过终点，哭着给妈妈打电话。', false)];
    artifacts.setState({ items: [], jobs: [], diaryDecisions: {}, isProcessing: false, unreadLetterCount: 0 });
    characters.setState({ characters: actors }); characters.getState().markCharactersWarm();
    chats.setState({ chats: [normalizeConversation({ id: 'publication-smoke-room', name: '验证群聊', type: 'group', mode: 'open_chat', memberIds: actors.map((actor) => actor.id),
      isActive: true, runtimeEventsV2: [], layeredMemories: [], createdAt: now - 4 * 3600000, updatedAt: now, lastMessageAt: now - 3 * 3600000 })] });
    chats.getState().markChatsWarm();
    window.__publication = { artifacts, chats, characters, projectWorldMoments };
    return true;
  })()`);
  // Shift business dates without accelerating HTTP timeout timers.
  await wait(15_000);
  report.appointments = await cdp.evaluate(`(() => window.__publication.chats.getState().chats[0].runtimeEventsV2.filter((event) => event.payload.artifactType === 'daily_moment_schedule').map((event) => event.payload.readyAt))()`);
  assert.equal(report.appointments.length, 2, 'Application timer did not create independent moment appointments');
  await cdp.evaluate(`(async () => {
    const { artifacts, chats, characters } = window.__publication;
    const { useSettingsStore } = await import('/src/stores/useSettingsStore.ts');
    const { runDailyMomentFlow } = await import('/src/services/dailyMomentRuntime.ts');
    await artifacts.getState().resumeProcessing();
    window.__publicationJump(3 * 3600000);
    for (let attempt = 0; attempt < 3; attempt++) {
    try { await runDailyMomentFlow('publication-smoke-room', {
      isCurrentSource: () => true, getChats: () => chats.getState().chats,
      getCharacters: () => characters.getState().characters, getProfiles: () => useSettingsStore.getState().aiProfiles,
      loadCharacter: (id) => characters.getState().loadCharacter(id),
      applyChatRuntimePatch: chats.getState().applyChatRuntimePatch, onImageError: (error) => { throw error; },
    }); break; } catch (error) {
      const failures = error.errors || [error];
      if (attempt < 2 && failures.every((item) => item instanceof SyntaxError || /503|UNAVAILABLE/.test(item.message || ''))) {
        await new Promise((resolve) => setTimeout(resolve, 2000)); continue;
      }
      throw new Error(JSON.stringify(failures.map((item) => ({ message: item.message, status: item.diagnostic?.status }))));
    }
    }
    return true;
  })()`);
  report.beforeMidnight = await cdp.evaluate(snapshot);
  assert.equal(report.beforeMidnight.items.filter((item) => item.kind === 'birth_letter').length, 1, 'Birth letter did not generate');
  assert.equal(report.beforeMidnight.items.filter((item) => item.kind === 'diary').length, 0, 'Diary was written before the day ended');
  assert.deepEqual(report.beforeMidnight.moments.map((item) => item.actorId), ['smoke-milestone-b'], 'Model should decline mundane chat and share the milestone');
  console.log('Verified real moments and birth letter; advancing across midnight.');
  await cdp.evaluate('(() => { window.__publicationJump(8 * 3600000); document.dispatchEvent(new Event("visibilitychange")); return true; })()');
  await wait(8000);
  report.diaryAppointments = (await cdp.evaluate(snapshot)).jobs;
  assert.equal(report.diaryAppointments.filter((job) => job.kind === 'diary').length, 2, 'Cross-day application check did not enqueue both diaries');
  await cdp.evaluate('(async () => { window.__publicationJump(46 * 60_000); await window.__publication.artifacts.getState().resumeProcessing(); return true; })()');
  report.afterMidnight = await cdp.evaluate(snapshot);
  for (let retry = 0; retry < 2 && report.afterMidnight.jobs.some((job) => job.status === 'failed' && /503|UNAVAILABLE/.test(job.error || '')); retry++) {
    await wait(2000);
    await cdp.evaluate('(async () => { await window.__publication.artifacts.getState().resumeProcessing(); return true; })()');
    report.afterMidnight = await cdp.evaluate(snapshot);
  }
  assert.equal(report.afterMidnight.items.filter((item) => item.kind === 'diary' && item.characterId === 'smoke-milestone-b').length, 1, 'Meaningful diary missing after midnight');
  assert.equal(report.afterMidnight.items.filter((item) => item.kind === 'diary' && item.characterId === 'smoke-ordinary').length, 0, 'Mundane diary should be declined');
  assert.equal(report.afterMidnight.decisions.length, 1, 'Diary skip decision missing');
  await cdp.evaluate(`(async () => { const { flushBufferedPersistenceWrites } = await import('/src/stores/storePersistenceScope.ts'); flushBufferedPersistenceWrites(); return true; })()`);
  await wait(2000);
  await cdp.page('Page.reload', { ignoreCache: true });
  await wait(5000);
  report.reloaded = await cdp.evaluate(`(async () => {
    const { useCharacterArtifactStore: store, ensureCharacterArtifactStoreHydrated } = await import('/src/stores/useCharacterArtifactStore.ts');
    await ensureCharacterArtifactStoreHydrated();
    return { items: store.getState().items.map(({ kind, characterId }) => ({ kind, characterId })), decisions: Object.keys(store.getState().diaryDecisions || {}) };
  })()`);
  assert.equal(report.reloaded.items.length, report.afterMidnight.items.length, 'Refresh lost or duplicated artifacts');
  assert.equal(report.reloaded.decisions.length, 1, 'Refresh lost the skip decision');
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.ok = false;
  report.error = String(error.stack || error).split(profile.apiKey).join('[REDACTED]');
  console.error(report.error); process.exitCode = 1;
} finally {
  await writeFile(`${reportDir}/report.json`, JSON.stringify(report, null, 2));
  if (browserContextId) await cdp.send('Target.disposeBrowserContext', { browserContextId });
  cdp.ws.close();
}
