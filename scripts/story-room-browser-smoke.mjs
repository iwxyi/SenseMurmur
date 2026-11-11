const CLIENT_URL = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5174';
const CDP_URL = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';

async function cdpFetch(path, init) {
  const response = await fetch(`${CDP_URL}${path}`, init);
  if (!response.ok) throw new Error(`CDP ${path} failed: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.ws = new WebSocket(webSocketDebuggerUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  close() {
    this.ws.close();
  }

  clearEvents() {
    this.events = [];
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(cdp, expression, awaitPromise = false) {
  let result;
  try {
    result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
  } catch (error) {
    if (!String(error?.message || error).includes('Promise was collected')) throw error;
    await wait(350);
    result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
  }
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function getPage() {
  const pages = await cdpFetch('/json/list');
  const page = pages.find((item) => item.type === 'page');
  if (page) return page;
  return cdpFetch(`/json/new?${encodeURIComponent(`${CLIENT_URL}/chats`)}`, { method: 'PUT' });
}

const seedStoryRoomExpression = String.raw`
(async () => {
  const [
    { useChatStore },
    { useMessageStore },
    { useCharacterStore },
    { useAuthStore },
    { useSettingsStore },
    { useUIStore },
    { useSchedulerStore },
    { flushBufferedPersistenceWrites },
    { normalizeConversation },
    characterTypes,
    narrativeRuntime,
    { createConversationInitializationState },
  ] = await Promise.all([
    import('/src/stores/useChatStore.ts'),
    import('/src/stores/useMessageStore.ts'),
    import('/src/stores/useCharacterStore.ts'),
    import('/src/stores/useAuthStore.ts'),
    import('/src/stores/useSettingsStore.ts'),
    import('/src/stores/useUIStore.ts'),
    import('/src/stores/useSchedulerStore.ts'),
    import('/src/stores/storePersistenceScope.ts'),
    import('/src/types/chat.ts'),
    import('/src/types/character.ts'),
    import('/src/services/narrativeRuntime.ts'),
    import('/src/services/conversationInitialization.ts'),
  ]);
  const now = Date.now();
  const baseCharacter = {
    avatar: '',
    personality: characterTypes.DEFAULT_PERSONALITY,
    behavior: characterTypes.DEFAULT_CHARACTER_BEHAVIOR,
    expertise: [],
    speakingStyle: '',
    background: '',
    relationships: [],
    memory: characterTypes.DEFAULT_CHARACTER_MEMORY,
    intervention: characterTypes.DEFAULT_CHARACTER_INTERVENTION,
    isPreset: false,
    createdAt: now,
    updatedAt: now,
  };
  const chat = normalizeConversation({
    id: 'story-browser-smoke',
    type: 'group',
    mode: 'scripted_play',
    sessionKind: { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' },
    modeConfig: { freeSpeaking: true, allowInterruptions: true, allowPrivateThreads: false, allowDirectorInterventions: true, showRoleActions: false },
    modeState: { phase: 'free', initialization: createConversationInitializationState('completed', 'lin|nurse', now) },
    name: '旧医院浏览器烟测',
    topic: '雨夜旧医院',
    style: 'roleplay',
    runtimeEvolutionIntensity: 'slow',
    memberIds: ['lin', 'nurse'],
    speed: 1,
    isActive: true,
    allowIntervention: true,
    topicSeed: '',
    scenarioState: {
      phase: 'choice',
      sceneBeatCount: 0,
      choiceEpoch: 2,
      storyGoal: '查清旧医院停电真相',
      storySituation: '林医生在旧医院走廊发现新鲜血迹。',
      branches: [
        { branchId: 'ask-nurse', label: '让林医生追问护士昨晚去向', prompt: '林医生逼问护士说出停电时的真相', status: 'available', choiceEpoch: 2, intent: '逼问', risk: '激怒护士', reward: '得到停电线索' },
        { branchId: 'inspect-blood', label: '让主角检查墙上的新鲜血迹', prompt: '主角检查墙上的新鲜血迹', status: 'available', choiceEpoch: 2, intent: '探索', risk: '暴露位置', reward: '发现新证据' },
      ],
      openQuestions: ['旧医院为什么停电？'],
      clues: ['墙上的新鲜血迹'],
      stakes: ['护士可能反咬一口'],
      relationshipShifts: [],
      choiceHistory: [],
    },
    worldState: { phase: 'warming', mood: '', focus: '', recentEvent: '', conflictAxes: [] },
    governance: { ownerCharacterId: null, adminCharacterIds: [], autoModeration: false, allowMute: true, allowPrivateThreads: false },
    dramaRules: { allowCliques: false, allowMockery: false, allowAlliances: true, allowContempt: false },
    directorControls: { allowSpeakAs: true, allowDirectorMode: true, allowEventInjection: true, allowForcedReply: true },
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
  });
  const storyCharacters = [
    { id: 'lin', name: '林医生' },
    { id: 'nurse', name: '护士' },
  ];
  const buildStoryEventMessage = ({ id, timestamp, events, extraBlocks = [], storyQuality = null }) => {
    const storyEvents = narrativeRuntime.normalizeStoryEvents(events);
    const narrativeTurn = narrativeRuntime.buildNarrativeTurnFromStoryEvents({
      conversation: chat,
      events: storyEvents,
      characters: storyCharacters,
    });
    return {
      id,
      chatId: chat.id,
      type: 'ai',
      senderId: 'narrator',
      senderName: '旁白',
      content: narrativeRuntime.buildStoryEventsVisibleText(storyEvents, storyCharacters),
      emotion: 0,
      timestamp,
      isDeleted: false,
      metadata: {
        storyEvents,
        storyChoices: narrativeRuntime.getStoryChoicesFromEvents(storyEvents),
        ...(storyQuality ? { storyQuality } : {}),
        narrativeTurn: narrativeTurn ? {
          ...narrativeTurn,
          blocks: [...narrativeTurn.blocks, ...extraBlocks],
        } : undefined,
      },
    };
  };
  const messages = [
    buildStoryEventMessage({
      id: 'intro',
      timestamp: now,
      events: [
        { type: 'narration', text: '雨水顺着旧医院走廊的窗缝往下流，墙上的新鲜血迹还没有干。' },
        { type: 'speech', characterId: 'lin', text: '不要碰那道血迹，先看护士的反应。' },
      ],
      storyQuality: {
        score: 72,
        labels: ['has_narration', 'has_speech', 'has_story_hook'],
        gaps: ['weak_concrete_scene'],
      },
    }),
    buildStoryEventMessage({
      id: 'choice-source',
      timestamp: now + 1,
      events: [
        {
          type: 'choice_point',
          choices: [
            { label: '让林医生追问护士昨晚去向', prompt: '林医生逼问护士说出停电时的真相', intent: '逼问', risk: '激怒护士', reward: '得到停电线索' },
            { label: '让主角检查墙上的新鲜血迹', prompt: '主角检查墙上的新鲜血迹', intent: '探索', risk: '暴露位置', reward: '发现新证据' },
          ],
        },
      ],
      extraBlocks: [
        { id: 'choice-diagnostic', actorId: 'narrator', actorKind: 'system', kind: 'system_note', displayMode: 'system_panel', text: '新的抉择点\n前情：林医生在走廊发现血迹。\n取舍：逼问护士 / 检查血迹' },
      ],
    }),
  ];
  const writeIndexedDbJson = (key, value) => new Promise((resolve, reject) => {
    const request = indexedDB.open('pneumata-local-store', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('kv')) database.createObjectStore('kv');
    };
    request.onerror = () => reject(request.error || new Error('open indexeddb failed'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('kv', 'readwrite');
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        const error = transaction.error || new Error('write indexeddb failed');
        database.close();
        reject(error);
      };
      transaction.objectStore('kv').put(JSON.stringify(value), key);
    };
  });
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('pneumata-workflow-runs', 3);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('runs')) database.createObjectStore('runs');
      if (!database.objectStoreNames.contains('events')) database.createObjectStore('events', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('outbox')) database.createObjectStore('outbox', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('outbox_consumers')) database.createObjectStore('outbox_consumers', { keyPath: 'key' });
    };
    request.onerror = () => reject(request.error || new Error('open workflow runs failed'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('runs', 'readwrite');
      const cursor = transaction.objectStore('runs').openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if (String(entry.key).endsWith('\ngroup-conversation-story-browser-smoke')) entry.delete();
        entry.continue();
      };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { const error = transaction.error || new Error('clear smoke run failed'); database.close(); reject(error); };
    };
  });
  localStorage.setItem('pneumata-auth-mode', 'local');
  localStorage.removeItem('pneumata-token');
  localStorage.removeItem('pneumata-user');
  localStorage.setItem('pneumata-cloud-sync-enabled', '0');
  useAuthStore.setState({ authMode: 'local', token: null, user: null, isLoggedIn: false, isLoading: false });
  await Promise.all([
    useChatStore.persist.hasHydrated() ? undefined : useChatStore.persist.rehydrate(),
    useMessageStore.persist.hasHydrated() ? undefined : useMessageStore.persist.rehydrate(),
    useCharacterStore.persist.hasHydrated() ? undefined : useCharacterStore.persist.rehydrate(),
    useSettingsStore.persist.hasHydrated() ? undefined : useSettingsStore.persist.rehydrate(),
    useUIStore.persist.hasHydrated() ? undefined : useUIStore.persist.rehydrate(),
  ]);
  useSchedulerStore.getState().stop();
  useSchedulerStore.getState().pause();
  useSettingsStore.setState((state) => ({
    ...state,
    developerMode: false,
    developerUI: { ...state.developerUI, showAdvancedRuntimePanels: false },
  }));
  useUIStore.setState((state) => ({ ...state, rightPanelOpen: true, rightPanelTab: 'narrative' }));
  useCharacterStore.setState({
    characters: [
      { ...baseCharacter, id: 'lin', name: '林医生' },
      { ...baseCharacter, id: 'nurse', name: '护士' },
    ],
    lastSyncedAt: now,
    pendingOperations: [],
    pendingEditSyncCount: 0,
    pendingEditSyncError: null,
    fieldConflicts: [],
    isLoading: false,
  });
  useChatStore.setState({
    chats: [chat],
    currentChatId: chat.id,
    lastSyncedAt: now,
    pendingOperations: [],
    pendingEditSyncCount: 0,
    pendingEditSyncError: null,
    remoteDeletedChatIds: [],
    remoteDeletedChats: [],
    fieldConflicts: [],
    chatSummaryLoadedAt: now,
    isLoading: false,
  });
  useMessageStore.setState({
    activeChatId: chat.id,
    messages,
    messageWindowsByChatId: {
      [chat.id]: {
        messages,
        lastSyncedAt: now,
        updatedAt: now + 1,
        remoteExhausted: true,
        activeLimit: 40,
      },
    },
    isLoading: false,
    isLoadingOlder: false,
    hasMore: false,
  });
  flushBufferedPersistenceWrites();
  await Promise.all([
    writeIndexedDbJson('pneumata-chats-guest', {
      state: {
        chats: [chat],
        currentChatId: chat.id,
        lastSyncedAt: now,
        pendingOperations: [],
        fieldConflicts: [],
      },
      version: 3,
    }),
    writeIndexedDbJson('pneumata-messages-guest', {
      state: {
        messageWindowsByChatId: {
          [chat.id]: {
            messages,
            lastSyncedAt: now,
            updatedAt: now + 1,
            remoteExhausted: true,
            activeLimit: 40,
          },
        },
        pendingOperations: [],
      },
      version: 3,
    }),
    writeIndexedDbJson('pneumata-characters-guest', {
      state: {
        characters: [
          { ...baseCharacter, id: 'lin', name: '林医生' },
          { ...baseCharacter, id: 'nurse', name: '护士' },
        ],
        lastSyncedAt: now,
        pendingOperations: [],
        fieldConflicts: [],
      },
      version: 3,
    }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 350));
  history.pushState(null, '', '/chats/story-browser-smoke');
  window.dispatchEvent(new PopStateEvent('popstate'));
  return 'seeded';
})()
`;

const verifyStoryTemplateOpeningExpression = String.raw`
(async () => {
  const [
    { getRoomTemplate },
    { buildGroupChatDraft },
    { STORY_ENGINE },
  ] = await Promise.all([
    import('/src/services/roomTemplates.ts'),
    import('/src/services/chatDraftBuilder.ts'),
    import('/src/services/engines/storyEngine.ts'),
  ]);
  const keys = ['story_reader', 'campus_story', 'romance_story'];
  const buildDraft = (key) => {
    const template = getRoomTemplate(key);
    const topic = (template.topicPlaceholder || template.label).replace(/^例如：/, '').split('、')[0] || template.label;
    const draft = buildGroupChatDraft({
      type: 'group',
      name: template.label,
      topic,
      style: template.style,
      runtimeEvolutionIntensity: template.runtimeEvolutionIntensity,
      sessionKind: template.sessionKind,
      storyBranchMode: template.defaults?.storyBranchMode,
      storyBackground: template.defaults?.storyBackground,
      storyDirection: template.defaults?.storyDirection,
      storyOutline: template.defaults?.storyOutline,
      memberIds: ['lin', 'nurse'],
      operatorIds: [],
      showRoleActions: true,
      seedMemoryText: '',
      seedArtifactText: '',
      ownerCharacterId: null,
      adminCharacterIds: [],
      autoModeration: false,
      allowMute: true,
      allowPrivateThreads: false,
      allowCliques: false,
      allowMockery: false,
      mood: '',
      focus: '',
      recentEvent: '',
      allowSpeakAs: true,
      allowDirectorMode: true,
      allowEventInjection: true,
      allowForcedReply: true,
    });
    return {
      ...draft,
      id: 'template-smoke-' + key,
      createdAt: 1,
      updatedAt: 1,
      lastMessageAt: 1,
    };
  };
  return JSON.stringify(keys.map((key) => {
    const chat = buildDraft(key);
    const prompt = STORY_ENGINE.buildGenerationPromptContext?.({
      conversation: chat,
      characters: [],
      messages: [],
      speaker: { id: 'narrator', name: '旁白' },
    });
    const constraints = (prompt?.additionalConstraints || []).join('\n');
    const state = chat.scenarioState || {};
    return {
      key,
      scenarioId: chat.sessionKind?.scenarioId,
      showRoleActions: chat.showRoleActions,
      phase: state.phase,
      beatKind: state.storyBeatKind,
      choicePolicy: state.storyChoicePolicy,
      hasStoryGoal: Boolean(state.storyGoal && state.storyGoal.length > 20),
      hasStorySituation: Boolean(state.storySituation && state.storySituation.length > 20),
      hasCurrentScene: Boolean(state.currentScene?.summary && state.currentScene.summary.length > 20),
      openQuestionCount: state.openQuestions?.length || 0,
      clueCount: state.clues?.length || 0,
      stakeCount: state.stakes?.length || 0,
      hasOpeningPrompt: constraints.includes('Opening beat: start inside the current scene')
        && constraints.includes('include at least one spoken line')
        && constraints.includes('specific unresolved hook')
        && constraints.includes('Do not output storyEvents.choice_point'),
      hasAssetPrompt: constraints.includes('Current chapter goal:')
        && constraints.includes('Current scene:')
        && constraints.includes('Open questions to preserve or answer deliberately:'),
    };
  }));
})()
`;

function assertCondition(condition, message, detail) {
  if (!condition) {
    const suffix = detail ? `\n${JSON.stringify(detail, null, 2)}` : '';
    throw new Error(`${message}${suffix}`);
  }
}

function stringifyConsoleArg(arg) {
  if (!arg) return '';
  if (typeof arg.value === 'string') return arg.value;
  if (arg.value != null) {
    try {
      return JSON.stringify(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  return arg.description || '';
}

function findForbiddenNormalConsoleLeaks(events) {
  const forbidden = [
    /\[ai-raw-response\]/,
    /\[ai-generation-failure/,
    /\[dev:/,
    /\[story-reader\]/,
    /\[group-loop:/,
    /story-protocol/,
    /storyChoiceGate|choiceEpoch|storyEvents|storyChoices/,
    /新的抉择点|前情：|取舍：/,
  ];
  return events
    .filter((event) => event.method === 'Runtime.consoleAPICalled')
    .map((event) => ({
      type: event.params?.type,
      text: (event.params?.args || []).map(stringifyConsoleArg).filter(Boolean).join(' '),
    }))
    .filter((entry) => forbidden.some((pattern) => pattern.test(entry.text)));
}

async function main() {
  const page = await getPage();
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.open();
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: `${CLIENT_URL}/chats` });
    await wait(1500);
    const templateOpening = JSON.parse(await evaluate(cdp, verifyStoryTemplateOpeningExpression, true));
    templateOpening.forEach((item) => {
      assertCondition(item.scenarioId === 'story-reader', 'Story template did not create a story-reader session', item);
      assertCondition(item.showRoleActions === false, 'Story template exposed role action buttons by default', item);
      assertCondition(item.phase === 'scene' && item.beatKind === 'establish' && item.choicePolicy === 'forbid', 'Story template did not start in a guarded establish beat', item);
      if (item.key === 'story_reader') {
        assertCondition(!item.hasStoryGoal && !item.hasStorySituation && !item.hasCurrentScene, 'Blank story template unexpectedly hard-coded opening story assets', item);
        assertCondition(item.openQuestionCount <= 1 && item.clueCount === 0 && item.stakeCount === 0, 'Blank story template unexpectedly hard-coded story hooks, clues, or stakes', item);
      } else {
        assertCondition(item.hasStoryGoal && item.hasStorySituation && item.hasCurrentScene, 'Preset story template did not produce concrete opening story assets', item);
        assertCondition(item.openQuestionCount >= 2 && item.clueCount >= 1 && item.stakeCount >= 1, 'Preset story template did not produce enough opening hooks, clues, and stakes', item);
      }
      assertCondition(item.hasOpeningPrompt, 'Story template opening prompt did not enforce an in-scene hook-first opening', item);
      assertCondition(item.hasAssetPrompt, 'Story template opening prompt did not include story asset anchors', item);
    });
    await evaluate(cdp, seedStoryRoomExpression, true);
    await wait(2500);

    const before = JSON.parse(await evaluate(cdp, `JSON.stringify({
      path: location.pathname,
      text: document.body.innerText,
      buttons: Array.from(document.querySelectorAll('button')).map((button) => button.innerText.trim()).filter(Boolean),
      messageTypes: Array.from(document.querySelectorAll('[data-message-type]')).map((node) => node.getAttribute('data-message-type')),
      hasDiagnosticText: document.body.innerText.includes('新的抉择点'),
      hasDeveloperChoiceMeta: /意图[：:]|风险[：:]|收益[：:]/.test(document.body.innerText),
      hasStoryQuality: document.body.innerText.includes('故事质量') || document.body.innerText.includes('质量 72'),
      hasDeveloperTab: Array.from(document.querySelectorAll('button')).some((button) => button.innerText.trim() === '开发者'),
      hasProtocolDiagnosticPanel: document.body.innerText.includes('故事协议诊断') || document.body.innerText.includes('epoch：'),
      hasContinueButton: Array.from(document.querySelectorAll('button')).some((button) => button.innerText.includes('继续剧情')),
      hasChoicePrompt: document.body.innerText.includes('选择接下来的剧情走向'),
      hasSpeech: document.body.innerText.includes('不要碰那道血迹')
    })`));
    assertCondition(before.path === '/chats/story-browser-smoke', 'Story smoke did not navigate to the seeded chat', before);
    assertCondition(before.hasChoicePrompt, 'Story choice panel was not visible before choosing', before);
    assertCondition(before.hasSpeech, 'Story speech bubble text was not visible before choosing', before);
    assertCondition(!before.hasDiagnosticText, 'Developer-only story diagnostic text leaked to normal UI', before);
    assertCondition(!before.hasDeveloperChoiceMeta, 'Developer-only story choice meta leaked to normal UI', before);
    assertCondition(!before.hasStoryQuality, 'Developer-only story quality trace leaked to normal UI', before);
    assertCondition(!before.hasDeveloperTab, 'Developer sidebar tab leaked to normal story UI', before);
    assertCondition(!before.hasProtocolDiagnosticPanel, 'Story protocol diagnostics leaked to normal story UI', before);
    assertCondition(!before.hasContinueButton, 'Story room exposed a continue button instead of auto-running', before);
    assertCondition(before.buttons.includes('让林医生追问护士昨晚去向'), 'Expected story choice button was missing', before.buttons);
    const initialNormalConsoleLeaks = findForbiddenNormalConsoleLeaks(cdp.events);
    assertCondition(initialNormalConsoleLeaks.length === 0, 'Developer-only story console logs leaked during normal story UI bootstrap', initialNormalConsoleLeaks);
    cdp.clearEvents();
    await evaluate(cdp, `Promise.all([
      import('/src/stores/useSettingsStore.ts'),
      import('/src/stores/useUIStore.ts'),
    ]).then(([{ useSettingsStore }, { useUIStore }]) => {
      useSettingsStore.setState((state) => ({
        ...state,
        developerMode: true,
        developerUI: { ...state.developerUI, showAdvancedRuntimePanels: true },
      }));
      useUIStore.setState((state) => ({ ...state, rightPanelOpen: true, rightPanelTab: 'narrative' }));
      return 'developer-story-quality-enabled';
    })`, true);
    await wait(300);
    const narrativeTabState = JSON.parse(await evaluate(cdp, `Promise.all([
      import('/src/stores/useUIStore.ts'),
    ]).then(([{ useUIStore }]) => {
      const buttons = Array.from(document.querySelectorAll('button')).map((button) => button.innerText.trim()).filter(Boolean);
      const narrativeTab = Array.from(document.querySelectorAll('button')).find((button) => {
        const text = button.innerText.trim();
        return text === '故事' || text.includes('叙事线');
      });
      if (narrativeTab) narrativeTab.click();
      return JSON.stringify({
        clicked: Boolean(narrativeTab),
        buttons,
        ui: {
          rightPanelOpen: useUIStore.getState().rightPanelOpen,
          rightPanelTab: useUIStore.getState().rightPanelTab,
        },
        text: document.body.innerText.slice(0, 1800),
      });
    })`, true));
    assertCondition(narrativeTabState.clicked, 'Story narrative sidebar tab was not available for quality diagnostics', narrativeTabState);
    await wait(500);
    const developerQuality = JSON.parse(await evaluate(cdp, `JSON.stringify({
      text: document.body.innerText,
      hasStoryQuality: document.body.innerText.includes('故事质量') && document.body.innerText.includes('质量 72'),
      hasStoryQualityLabel: document.body.innerText.includes('旁白') && document.body.innerText.includes('气泡') && document.body.innerText.includes('悬念钩子'),
      hasStoryQualityGap: document.body.innerText.includes('待补：场景细节弱')
    })`));
    assertCondition(developerQuality.hasStoryQuality, 'Developer advanced mode did not show story quality score', developerQuality);
    assertCondition(developerQuality.hasStoryQualityLabel, 'Developer advanced mode did not show story quality labels', developerQuality);
    assertCondition(developerQuality.hasStoryQualityGap, 'Developer advanced mode did not show story quality gaps', developerQuality);
    await evaluate(cdp, `Promise.all([
      import('/src/stores/useSettingsStore.ts'),
      import('/src/stores/useUIStore.ts'),
    ]).then(([{ useSettingsStore }, { useUIStore }]) => {
      useSettingsStore.setState((state) => ({
        ...state,
        developerMode: false,
        developerUI: { ...state.developerUI, showAdvancedRuntimePanels: false },
      }));
      useUIStore.setState((state) => ({ ...state, rightPanelOpen: false, rightPanelTab: 'members' }));
      return 'developer-story-quality-disabled';
    })`, true);
    cdp.clearEvents();
    await wait(500);
    const choiceSourceMetadata = JSON.parse(await evaluate(cdp, `import('/src/stores/useMessageStore.ts').then(({ useMessageStore }) => {
      const message = useMessageStore.getState().messages.find((item) => item.id === 'choice-source');
      return JSON.stringify({
        storyEventTypes: message?.metadata?.storyEvents?.map((event) => event.type) || [],
        storyChoiceLabels: message?.metadata?.storyChoices?.map((choice) => choice.label) || [],
      });
    })`, true));
    assertCondition(choiceSourceMetadata.storyEventTypes.includes('choice_point'), 'Story smoke choice source did not use storyEvents.choice_point', choiceSourceMetadata);
    assertCondition(choiceSourceMetadata.storyChoiceLabels.includes('让林医生追问护士昨晚去向'), 'Story smoke did not derive visible choices from storyEvents', choiceSourceMetadata);

    await evaluate(cdp, `(() => {
      const root = Array.from(document.querySelectorAll('[data-message-id]')).find((node) => node.textContent?.includes('不要碰那道血迹'));
      if (!root) throw new Error('story speech bubble node not found');
      const candidates = Array.from(root.querySelectorAll('*')).filter((node) => node.textContent?.includes('不要碰那道血迹'));
      const bubble = candidates.at(-1);
      if (!bubble) throw new Error('story speech bubble text node not found');
      bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: 120, clientY: 180, button: 2 }));
      return 'context-menu-opened';
    })()`);
    await wait(450);
    const contextMenu = JSON.parse(await evaluate(cdp, `JSON.stringify({
      text: Array.from(document.querySelectorAll('[role="menu"]')).map((node) => node.innerText).join('\\n'),
      menuItems: Array.from(document.querySelectorAll('[role="menuitem"]')).map((node) => node.innerText.trim()).filter(Boolean)
    })`));
    assertCondition(contextMenu.menuItems.includes('复制'), 'Story speech bubble did not expose the standard copy context menu item', contextMenu);
    assertCondition(contextMenu.menuItems.includes('AI分析'), 'Story speech bubble did not expose the standard AI analysis context menu item', contextMenu);
    assertCondition(contextMenu.menuItems.some((item) => item.includes('表达反馈')), 'Story speech bubble did not expose the standard expression feedback context menu item', contextMenu);
    await evaluate(cdp, `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.body.click();
      return 'context-menu-closed';
    })()`);
    await wait(250);

    await evaluate(cdp, `(() => {
      const root = Array.from(document.querySelectorAll('[data-message-id]')).find((node) => node.textContent?.includes('不要碰那道血迹'));
      if (!root) throw new Error('story speech bubble node not found for avatar click');
      const avatar = root.querySelector('.MuiAvatar-root');
      if (!avatar) throw new Error('story speech avatar not found');
      avatar.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'avatar-clicked';
    })()`);
    await wait(900);
    await evaluate(cdp, `(() => {
      const detailsButton = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.trim() === '角色详情');
      if (!detailsButton) throw new Error('character details action not found');
      detailsButton.click();
      return 'details-clicked';
    })()`);
    await wait(1200);
    const characterPage = JSON.parse(await evaluate(cdp, `JSON.stringify({
      path: location.pathname,
      search: location.search,
      text: document.body.innerText.slice(0, 1200)
    })`));
    assertCondition(characterPage.path.includes('/characters/lin/edit'), 'Avatar details did not navigate to the character editor', characterPage);
    await evaluate(cdp, `history.back(); 'back-requested'`);
    await wait(2200);
    const afterReturn = JSON.parse(await evaluate(cdp, `JSON.stringify({
      path: location.pathname,
      text: document.body.innerText,
      buttons: Array.from(document.querySelectorAll('button')).map((button) => button.innerText.trim()).filter(Boolean),
      storyBlockAnchors: Array.from(document.querySelectorAll('[data-scroll-anchor*="story-block"]')).filter((node) => !node.parentElement?.closest('[data-scroll-anchor*="story-block"]')).map((node) => node.getAttribute('data-scroll-anchor')),
      hasDiagnosticText: document.body.innerText.includes('新的抉择点'),
      hasDeveloperChoiceMeta: /意图[：:]|风险[：:]|收益[：:]/.test(document.body.innerText),
      hasDeveloperTab: Array.from(document.querySelectorAll('button')).some((button) => button.innerText.trim() === '开发者'),
      hasProtocolDiagnosticPanel: document.body.innerText.includes('故事协议诊断') || document.body.innerText.includes('epoch：'),
      hasContinueButton: Array.from(document.querySelectorAll('button')).some((button) => button.innerText.includes('继续剧情')),
      hasChoicePrompt: document.body.innerText.includes('选择接下来的剧情走向'),
      hasSpeech: document.body.innerText.includes('不要碰那道血迹')
    })`));
    assertCondition(afterReturn.path === '/chats/story-browser-smoke', 'Story smoke did not return to the seeded chat after character details', afterReturn);
    assertCondition(afterReturn.hasChoicePrompt, 'Story choice panel disappeared after returning from character details', afterReturn);
    assertCondition(afterReturn.hasSpeech, 'Story speech bubble disappeared after returning from character details', afterReturn);
    assertCondition(!afterReturn.hasDiagnosticText, 'Developer-only story diagnostic text leaked after returning from character details', afterReturn);
    assertCondition(!afterReturn.hasDeveloperChoiceMeta, 'Developer-only story choice meta leaked after returning from character details', afterReturn);
    assertCondition(!afterReturn.hasDeveloperTab, 'Developer sidebar tab leaked after returning from character details', afterReturn);
    assertCondition(!afterReturn.hasProtocolDiagnosticPanel, 'Story protocol diagnostics leaked after returning from character details', afterReturn);
    assertCondition(!afterReturn.hasContinueButton, 'Story room exposed a continue button after returning from character details', afterReturn);
    assertCondition(afterReturn.buttons.includes('让林医生追问护士昨晚去向'), 'Expected story choice button was missing after returning from character details', afterReturn.buttons);
    assertCondition(afterReturn.storyBlockAnchors.includes('intro:story-block:block-1') && afterReturn.storyBlockAnchors.includes('intro:story-block:block-2'), 'Story blocks disappeared after returning from character details', afterReturn.storyBlockAnchors);

    await evaluate(cdp, `(() => import('/src/stores/useMessageStore.ts').then(({ useMessageStore }) => {
      const longFirstBlock = '月奴的脚步声停在门外，铜环轻轻碰了一下门板。沈清婉没有立刻回头，只看见镜中烛火被风压得低了半寸。她把那枚扣襻收进袖中，像把一枚还没落子的棋子藏回掌心。窗外的雨声忽然密起来，檐下有人压低声音说了一句听不清的话。';
      const secondBlock = '第二段顺序验收：这句话必须等第一段逐字完成后才出现。';
      useMessageStore.getState().upsertMessage({
        id: 'live-reveal-story',
        chatId: 'story-browser-smoke',
        type: 'ai',
        senderId: 'narrator',
        senderName: '旁白',
        content: longFirstBlock + '\\n\\n' + secondBlock,
        emotion: 0,
        timestamp: Date.now() + 10,
        isDeleted: false,
        metadata: {
          narrativeTurn: {
            turnId: 'live-reveal-story-turn',
            turnKind: 'narrative_beat',
            povActorId: 'narrator',
            blocks: [
              { id: 'live-reveal-first', actorId: 'narrator', actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: longFirstBlock },
              { id: 'live-reveal-second', actorId: 'narrator', actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: secondBlock }
            ]
          }
        }
      });
      return 'live-reveal-inserted';
    }))()`, true);
    await wait(120);
    const liveRevealEarly = JSON.parse(await evaluate(cdp, `JSON.stringify({
      text: document.body.innerText,
      messageIds: Array.from(document.querySelectorAll('[data-message-id]')).map((node) => node.getAttribute('data-message-id'))
    })`));
    assertCondition(liveRevealEarly.text.includes('月奴'), 'Live narrative node did not show the first block', liveRevealEarly);
    assertCondition(liveRevealEarly.text.includes('第二段顺序验收'), 'Live narrative node did not show the full section together', liveRevealEarly);
    await wait(700);
    const liveRevealDone = JSON.parse(await evaluate(cdp, `JSON.stringify({
      text: document.body.innerText,
      messageIds: Array.from(document.querySelectorAll('[data-message-id]')).map((node) => node.getAttribute('data-message-id')),
      bottomDistance: (() => {
        const scrollBox = Array.from(document.querySelectorAll('div')).find((node) => {
          const style = getComputedStyle(node);
          return style.overflowY === 'auto' && node.scrollHeight > node.clientHeight;
        });
        return scrollBox ? Math.round(scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight) : null;
      })()
    })`));
    assertCondition(liveRevealDone.text.includes('第二段顺序验收'), 'Live narrative node lost the later block after reveal settled', liveRevealDone);
    assertCondition(liveRevealDone.messageIds.includes('live-reveal-story'), 'Live narrative reveal lost its message node', liveRevealDone.messageIds);
    assertCondition(liveRevealDone.bottomDistance == null || liveRevealDone.bottomDistance >= 0, 'Story scroll distance was invalid after reveal', liveRevealDone.bottomDistance);

    await evaluate(cdp, `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.includes('让林医生追问护士昨晚去向'));
      if (!button) throw new Error('choice button not found');
      button.click();
      return 'clicked';
    })()`);
    await wait(2200);

    const after = JSON.parse(await evaluate(cdp, `JSON.stringify({
      text: document.body.innerText,
      buttons: Array.from(document.querySelectorAll('button')).map((button) => button.innerText.trim()).filter(Boolean),
      messageIds: Array.from(document.querySelectorAll('[data-message-id]')).map((node) => node.getAttribute('data-message-id')),
      messageTypes: Array.from(document.querySelectorAll('[data-message-type]')).map((node) => node.getAttribute('data-message-type')),
      hasDeveloperChoiceMeta: /意图[：:]|风险[：:]|收益[：:]/.test(document.body.innerText),
      hasDeveloperTab: Array.from(document.querySelectorAll('button')).some((button) => button.innerText.trim() === '开发者'),
      hasProtocolDiagnosticPanel: document.body.innerText.includes('故事协议诊断') || document.body.innerText.includes('epoch：'),
      hasContinueButton: Array.from(document.querySelectorAll('button')).some((button) => button.innerText.includes('继续剧情'))
    })`));
    assertCondition(after.text.includes('你选择了'), 'Selected choice reading node was not visible after choosing', after);
    assertCondition(!after.buttons.includes('让林医生追问护士昨晚去向'), 'Story choice button remained visible after choosing', after.buttons);
    assertCondition(after.text.includes('你选择了\n让林医生追问护士昨晚去向'), 'Selected choice did not render as a reader selection panel', after);
    assertCondition(!after.hasDeveloperChoiceMeta, 'Developer-only selected choice meta leaked to normal UI', after);
    assertCondition(!after.hasDeveloperTab, 'Developer sidebar tab leaked after selecting a story choice', after);
    assertCondition(!after.hasProtocolDiagnosticPanel, 'Story protocol diagnostics leaked after selecting a story choice', after);
    assertCondition(!after.hasContinueButton, 'Story room exposed a continue button after choosing', after);
    const normalChoiceStore = JSON.parse(await evaluate(cdp, `Promise.all([
      import('/src/stores/useChatStore.ts'),
      import('/src/stores/useMessageStore.ts'),
    ]).then(([{ useChatStore }, { useMessageStore }]) => {
      const chat = useChatStore.getState().chats.find((item) => item.id === 'story-browser-smoke');
      const messages = useMessageStore.getState().messageWindowsByChatId['story-browser-smoke']?.messages || [];
      return JSON.stringify({
        phase: chat?.scenarioState?.phase,
        storyDirection: chat?.scenarioState?.storyDirection,
        selectedChoice: chat?.scenarioState?.selectedChoice,
        selectedChoiceEpoch: chat?.scenarioState?.selectedChoiceEpoch,
        choiceHistory: chat?.scenarioState?.choiceHistory,
        branches: chat?.scenarioState?.branches,
        messages: messages.map((message) => ({
          type: message.type,
          content: message.content,
          storyChoiceSelection: message.metadata?.storyChoiceSelection || null,
        })),
      });
    })`, true));
    assertCondition(normalChoiceStore.phase === 'branch', 'Normal story choice did not move the story into branch consequence phase', normalChoiceStore);
    assertCondition(normalChoiceStore.storyDirection === '林医生逼问护士说出停电时的真相', 'Normal story choice did not write the selected prompt into storyDirection', normalChoiceStore);
    assertCondition(normalChoiceStore.selectedChoice?.branchId === 'ask-nurse', 'Normal story choice did not preserve the selected branch id', normalChoiceStore);
    assertCondition(normalChoiceStore.selectedChoice?.risk === '激怒护士' && normalChoiceStore.selectedChoice?.reward === '得到停电线索', 'Normal story choice lost risk/reward metadata before consequence generation', normalChoiceStore);
    assertCondition(normalChoiceStore.selectedChoiceEpoch === 2, 'Normal story choice did not preserve the active choice epoch', normalChoiceStore);
    assertCondition(normalChoiceStore.choiceHistory?.some((choice) => choice.branchId === 'ask-nurse' && choice.label === '让林医生追问护士昨晚去向'), 'Normal story choice was not written into choiceHistory', normalChoiceStore);
    assertCondition(normalChoiceStore.branches?.some((branch) => branch.branchId === 'ask-nurse' && branch.status === 'chosen'), 'Normal story choice did not mark the selected branch as chosen', normalChoiceStore);
    assertCondition(normalChoiceStore.branches?.some((branch) => branch.branchId === 'inspect-blood' && branch.status === 'completed'), 'Normal story choice did not keep the unchosen branch as a completed alternative', normalChoiceStore);
    assertCondition(normalChoiceStore.messages?.some((message) => message.storyChoiceSelection?.branchId === 'ask-nurse'), 'Normal story choice was not persisted as a storyChoiceSelection message', normalChoiceStore);

    const storyRunAfterChoice = JSON.parse(await evaluate(cdp, `(async () => { const { listGroupBackgroundConversations } = await import('/src/services/groupBackgroundConversation.ts'); const runs = await listGroupBackgroundConversations('story-browser-smoke'); return JSON.stringify({ tasks: runs[0]?.tasks.map((task) => ({ status: task.status, kind: task.kind })) || [] }); })()`, true));
    assertCondition(storyRunAfterChoice.tasks.some((task) => task.kind === 'group_conversation_turn'), 'Story choice did not create a persisted background turn', storyRunAfterChoice);
    await evaluate(cdp, `(async () => { const { pauseGroupBackgroundConversation } = await import('/src/services/groupBackgroundConversation.ts'); await pauseGroupBackgroundConversation('story-browser-smoke'); return 'paused'; })()`, true);
    const choiceConsoleLeaks = findForbiddenNormalConsoleLeaks(cdp.events);
    assertCondition(choiceConsoleLeaks.length === 0, 'Developer-only story console logs leaked in normal story UI flow', choiceConsoleLeaks);
    console.log(JSON.stringify({
      ok: true,
      url: CLIENT_URL,
      cdp: CDP_URL,
      contextMenuItems: contextMenu.menuItems,
      selectedBranch: normalChoiceStore.selectedChoice?.branchId,
      persistedTurnKinds: storyRunAfterChoice.tasks.map((task) => task.kind),
    }, null, 2));
    return;

    await evaluate(cdp, `(() => Promise.all([
      import('/src/stores/useChatStore.ts'),
      import('/src/stores/useMessageStore.ts'),
      import('/src/services/engines/storyEngine.ts'),
      import('/src/services/narrativeRuntime.ts'),
      import('/src/types/chat.ts'),
    ]).then(async ([{ useChatStore }, { useMessageStore }, { STORY_ENGINE }, narrativeRuntime, { normalizeConversation }]) => {
      const characters = [{ id: 'lin', name: '林医生' }, { id: 'nurse', name: '护士' }];
      const buildStoryEventMessage = (chat, id, timestamp, events) => {
        const storyEvents = narrativeRuntime.normalizeStoryEvents(events);
        const narrativeTurn = narrativeRuntime.buildNarrativeTurnFromStoryEvents({
          conversation: chat,
          events: storyEvents,
          characters,
        });
        return {
          id,
          chatId: chat.id,
          type: 'ai',
          senderId: 'narrator',
          senderName: '旁白',
          content: narrativeRuntime.buildStoryEventsVisibleText(storyEvents, characters),
          emotion: 0,
          timestamp,
          isDeleted: false,
          metadata: {
            storyEvents,
            storyChoices: narrativeRuntime.getStoryChoicesFromEvents(storyEvents),
            narrativeTurn: narrativeTurn || undefined,
          },
        };
      };
      const applyCommit = async (chat, message) => {
        const commit = await STORY_ENGINE.onMessageCommitted({
          conversation: chat,
          characters,
          message,
        });
        return normalizeConversation({
          ...chat,
          scenarioState: { ...(chat.scenarioState || {}), ...(commit.chatPatch?.scenarioState || {}) },
          worldState: { ...(chat.worldState || {}), ...(commit.chatPatch?.worldState || {}) },
          updatedAt: message.timestamp,
          lastMessageAt: message.timestamp,
        });
      };
      const setChat = (chat) => {
        useChatStore.setState((state) => ({
          chats: state.chats.map((item) => item.id === chat.id ? chat : item),
          currentChatId: chat.id,
        }));
      };
      let chat = useChatStore.getState().chats.find((item) => item.id === 'story-browser-smoke');
      if (!chat) throw new Error('story chat missing before long-flow smoke');
      const now = Date.now();
      const firstConsequence = buildStoryEventMessage(chat, 'long-flow-first-consequence', now + 20, [
        { type: 'narration', text: '林医生把问题压得更低，走廊顶灯闪了一下。护士承认停电时有个拿铜钥匙的人进过档案室，代价是她后退半步，明显开始警觉。' },
        { type: 'speech', characterId: 'nurse', text: '我只看见钥匙，不知道那个人的脸。你再逼我，我就不往前走了。' },
      ]);
      useMessageStore.getState().upsertMessage(firstConsequence);
      chat = await applyCommit(chat, firstConsequence);
      setChat(chat);
      const pressureBeat = buildStoryEventMessage(chat, 'long-flow-pressure', now + 25, [
        { type: 'narration', text: '档案室门锁里传来极轻的转动声，旧医院走廊的雨味被一股消毒水气味压住。地上的血迹没有通向楼梯，反而在门前断掉，像有人故意把路线擦干净。' },
        { type: 'speech', characterId: 'lin', text: '钥匙是真的，血迹也是真的。现在的问题是，门里的人为什么还没有出来？' },
      ]);
      useMessageStore.getState().upsertMessage(pressureBeat);
      chat = await applyCommit(chat, pressureBeat);
      setChat(chat);
      const secondChoice = buildStoryEventMessage(chat, 'long-flow-second-choice', now + 30, [
        { type: 'narration', text: '档案室门锁里传来极轻的转动声，护士袖口露出一角被雨水洇开的名单。林医生必须在门里的人逃走前决定先抓哪条线。' },
        { type: 'speech', characterId: 'nurse', text: '别开门。名单上的名字如果被看见，我们都会有危险。' },
        {
          type: 'choice_point',
          choices: [
            { label: '让林医生立刻推开档案室门', prompt: '林医生推门确认门里的人和血迹来源', intent: '冒险', risk: '惊动门内的人', reward: '确认谁进入过档案室' },
            { label: '让护士交出袖口里的名单', prompt: '护士交出袖口里被雨水洇开的名单', intent: '揭露', risk: '护士可能彻底失去信任', reward: '得到失踪名单上的缺失名字' },
          ],
        },
      ]);
      useMessageStore.getState().upsertMessage(secondChoice);
      chat = await applyCommit(chat, secondChoice);
      setChat(chat);
      return 'long-flow-second-choice-seeded';
    }))()`, true);
    await wait(1800);
    const longFlowBeforeSecondChoice = JSON.parse(await evaluate(cdp, `JSON.stringify({
      text: document.body.innerText,
      buttons: Array.from(document.querySelectorAll('button')).map((button) => button.innerText.trim()).filter(Boolean),
      messageIds: Array.from(document.querySelectorAll('[data-message-id]')).map((node) => node.getAttribute('data-message-id')),
      choicePanelIndex: document.body.innerText.indexOf('选择接下来的剧情走向'),
      consequenceIndex: document.body.innerText.indexOf('护士承认停电时有个拿铜钥匙的人进过档案室'),
      secondChoiceIndex: document.body.innerText.indexOf('让护士交出袖口里的名单')
    })`));
    assertCondition(longFlowBeforeSecondChoice.text.includes('护士承认停电时有个拿铜钥匙的人进过档案室'), 'Long-flow smoke did not render the first consequence after selecting', longFlowBeforeSecondChoice);
    assertCondition(longFlowBeforeSecondChoice.buttons.includes('让护士交出袖口里的名单'), 'Long-flow smoke did not render the second choice button', longFlowBeforeSecondChoice.buttons);
    assertCondition(longFlowBeforeSecondChoice.consequenceIndex >= 0 && longFlowBeforeSecondChoice.secondChoiceIndex > longFlowBeforeSecondChoice.consequenceIndex, 'Long-flow second choice appeared before the selected consequence', longFlowBeforeSecondChoice);
    assertCondition(!longFlowBeforeSecondChoice.buttons.includes('让林医生追问护士昨晚去向'), 'Long-flow smoke reopened the previous choice button', longFlowBeforeSecondChoice.buttons);
    assertCondition(longFlowBeforeSecondChoice.messageIds.includes('intro'), 'Long-flow smoke lost the opening message before second choice', longFlowBeforeSecondChoice.messageIds);

    await evaluate(cdp, `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.includes('让护士交出袖口里的名单'));
      if (!button) throw new Error('second choice button not found');
      button.click();
      return 'second-choice-clicked';
    })()`);
    await wait(1800);
    const longFlowAfterSecondChoice = JSON.parse(await evaluate(cdp, `Promise.all([
      import('/src/stores/useChatStore.ts'),
      import('/src/stores/useMessageStore.ts'),
    ]).then(([{ useChatStore }, { useMessageStore }]) => {
      const chat = useChatStore.getState().chats.find((item) => item.id === 'story-browser-smoke');
      const messages = useMessageStore.getState().messageWindowsByChatId['story-browser-smoke']?.messages || [];
      const text = document.body.innerText;
      return JSON.stringify({
        text,
        buttons: Array.from(document.querySelectorAll('button')).map((button) => button.innerText.trim()).filter(Boolean),
        messageIds: Array.from(document.querySelectorAll('[data-message-id]')).map((node) => node.getAttribute('data-message-id')),
        phase: chat?.scenarioState?.phase,
        storyDirection: chat?.scenarioState?.storyDirection,
        selectedChoice: chat?.scenarioState?.selectedChoice,
        selectedChoiceEpoch: chat?.scenarioState?.selectedChoiceEpoch,
        choiceHistory: chat?.scenarioState?.choiceHistory,
        branches: chat?.scenarioState?.branches,
        selectionMessages: messages.filter((message) => message.metadata?.storyChoiceSelection).map((message) => ({
          content: message.content,
          branchId: message.metadata.storyChoiceSelection.branchId,
          label: message.metadata.storyChoiceSelection.label,
          choiceEpoch: message.metadata.storyChoiceSelection.choiceEpoch,
        })),
        firstSelectionIndex: text.indexOf('让林医生追问护士昨晚去向'),
        firstConsequenceIndex: text.indexOf('护士承认停电时有个拿铜钥匙的人进过档案室'),
        secondSelectionIndex: text.lastIndexOf('让护士交出袖口里的名单'),
      });
    })`, true));
    assertCondition(longFlowAfterSecondChoice.phase === 'branch', 'Long-flow second choice did not move back into branch consequence phase', longFlowAfterSecondChoice);
    assertCondition(longFlowAfterSecondChoice.storyDirection === '护士交出袖口里被雨水洇开的名单', 'Long-flow second choice did not write the selected prompt', longFlowAfterSecondChoice);
    assertCondition(longFlowAfterSecondChoice.selectedChoice?.label === '让护士交出袖口里的名单', 'Long-flow second choice did not preserve selected choice label', longFlowAfterSecondChoice);
    assertCondition(longFlowAfterSecondChoice.selectedChoiceEpoch === 3, 'Long-flow second choice did not preserve the second choice epoch', longFlowAfterSecondChoice);
    assertCondition(longFlowAfterSecondChoice.choiceHistory?.length >= 2, 'Long-flow second choice did not append to choice history', longFlowAfterSecondChoice);
    assertCondition(longFlowAfterSecondChoice.choiceHistory?.some((choice) => choice.label === '让林医生追问护士昨晚去向'), 'Long-flow lost the first selected choice history', longFlowAfterSecondChoice);
    assertCondition(longFlowAfterSecondChoice.choiceHistory?.some((choice) => choice.label === '让护士交出袖口里的名单'), 'Long-flow did not write the second selected choice history', longFlowAfterSecondChoice);
    assertCondition(longFlowAfterSecondChoice.branches?.some((branch) => branch.label === '让林医生立刻推开档案室门' && branch.status === 'completed'), 'Long-flow did not keep the second unchosen branch as completed history', longFlowAfterSecondChoice);
    assertCondition(longFlowAfterSecondChoice.selectionMessages?.filter((message) => message.label === '让护士交出袖口里的名单').length === 1, 'Long-flow duplicated the second choice selection message', longFlowAfterSecondChoice);
    assertCondition(!longFlowAfterSecondChoice.buttons.includes('让护士交出袖口里的名单'), 'Long-flow second choice button remained visible after choosing', longFlowAfterSecondChoice.buttons);
    assertCondition(longFlowAfterSecondChoice.firstSelectionIndex >= 0 && longFlowAfterSecondChoice.firstConsequenceIndex > longFlowAfterSecondChoice.firstSelectionIndex && longFlowAfterSecondChoice.secondSelectionIndex > longFlowAfterSecondChoice.firstConsequenceIndex, 'Long-flow reading order was not selection -> consequence -> second selection', longFlowAfterSecondChoice);
    assertCondition(longFlowAfterSecondChoice.messageIds.includes('intro'), 'Long-flow smoke lost the opening message after second choice', longFlowAfterSecondChoice.messageIds);

    await evaluate(cdp, `(() => Promise.all([
      import('/src/stores/useChatStore.ts'),
      import('/src/stores/useMessageStore.ts'),
      import('/src/stores/useSchedulerStore.ts'),
    ]).then(([{ useChatStore }, { useMessageStore }, { useSchedulerStore }]) => {
      useSchedulerStore.getState().stop();
      useSchedulerStore.getState().pause();
      const sourceChat = useChatStore.getState().chats.find((item) => item.id === 'story-browser-smoke');
      if (!sourceChat) throw new Error('source story chat not found');
      const now = Date.now();
      const customChat = {
        ...sourceChat,
        id: 'story-custom-input-smoke',
        name: '自定义走向烟测',
        isActive: false,
        scenarioState: {
          ...(sourceChat.scenarioState || {}),
          phase: 'scene',
          sceneBeatCount: 1,
          choiceEpoch: 7,
          storyGoal: '验证输入框会推动剧情走向',
          storyDirection: '',
          selectedChoice: null,
          selectedChoiceEpoch: null,
          branches: [],
          choiceHistory: [],
        },
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
      };
      const messages = [{
        id: 'custom-intro',
        chatId: customChat.id,
        type: 'ai',
        senderId: 'narrator',
        senderName: '旁白',
        content: '风从窗缝里挤进来，旧病房的门牌轻轻晃了一下。',
        emotion: 0,
        timestamp: now,
        isDeleted: false,
        metadata: {
          narrativeTurn: {
            turnId: 'custom-intro-turn',
            turnKind: 'narrative_beat',
            povActorId: 'narrator',
            blocks: [
              { id: 'custom-intro-prose', actorId: 'narrator', actorKind: 'narrator', kind: 'prose', displayMode: 'paragraph', text: '风从窗缝里挤进来，旧病房的门牌轻轻晃了一下。' }
            ]
          }
        }
      }];
      useChatStore.setState((state) => ({
        chats: [customChat, ...state.chats.filter((item) => item.id !== customChat.id)],
        currentChatId: customChat.id,
      }));
      useMessageStore.setState((state) => ({
        activeChatId: customChat.id,
        messages,
        messageWindowsByChatId: {
          ...state.messageWindowsByChatId,
          [customChat.id]: {
            messages,
            lastSyncedAt: now,
            updatedAt: now,
            remoteExhausted: true,
            activeLimit: 40,
          },
        },
        isLoading: false,
        isLoadingOlder: false,
        hasMore: false,
      }));
      history.pushState(null, '', '/chats/story-custom-input-smoke');
      window.dispatchEvent(new PopStateEvent('popstate'));
      return 'custom-input-seeded';
    }))()`, true);
    await wait(1800);
    const customInputBefore = JSON.parse(await evaluate(cdp, `JSON.stringify({
      path: location.pathname,
      placeholders: Array.from(document.querySelectorAll('textarea, input')).map((input) => input.getAttribute('placeholder') || '').filter(Boolean)
    })`));
    assertCondition(customInputBefore.placeholders.includes('安排剧情'), 'Story custom direction input did not expose the director placeholder', customInputBefore);
    await evaluate(cdp, `(() => {
      const input = Array.from(document.querySelectorAll('textarea, input')).find((node) => node.getAttribute('placeholder') === '安排剧情');
      if (!input) throw new Error('story custom direction input not found');
      const value = '让主角先反锁病房门，再低声试探护士';
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
      descriptor?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'custom-direction-filled';
    })()`);
    await wait(150);
    await evaluate(cdp, `(() => {
      const sendButton = Array.from(document.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === '发送' && !button.disabled);
      if (!sendButton) throw new Error('story custom direction send button not found');
      sendButton.click();
      return 'custom-direction-sent';
    })()`);
    await wait(1400);
    const customInputResult = JSON.parse(await evaluate(cdp, `JSON.stringify((() => {
      return {
        path: location.pathname,
        text: document.body.innerText,
        buttons: Array.from(document.querySelectorAll('button')).map((button) => button.innerText.trim()).filter(Boolean),
        messageTypes: Array.from(document.querySelectorAll('[data-message-type]')).map((node) => node.getAttribute('data-message-type')),
      };
    })())`));
    const customInputStore = JSON.parse(await evaluate(cdp, `Promise.all([
      import('/src/stores/useChatStore.ts'),
      import('/src/stores/useMessageStore.ts'),
    ]).then(([{ useChatStore }, { useMessageStore }]) => {
      const chat = useChatStore.getState().chats.find((item) => item.id === 'story-custom-input-smoke');
      const messages = useMessageStore.getState().messageWindowsByChatId['story-custom-input-smoke']?.messages || [];
      return JSON.stringify({
        phase: chat?.scenarioState?.phase,
        storyDirection: chat?.scenarioState?.storyDirection,
        selectedChoice: chat?.scenarioState?.selectedChoice,
        choiceHistory: chat?.scenarioState?.choiceHistory,
        branches: chat?.scenarioState?.branches,
        messages: messages.map((message) => ({
          type: message.type,
          content: message.content,
          storyChoiceSelection: message.metadata?.storyChoiceSelection || null,
        })),
      });
    })`, true));
    assertCondition(customInputResult.path === '/chats/story-custom-input-smoke', 'Custom story direction smoke did not navigate to the seeded chat', customInputResult);
    assertCondition(customInputResult.text.includes('你选择了'), 'Custom story direction did not render as a selected choice reading node', customInputResult);
    assertCondition(customInputResult.text.includes('让主角先反锁病房门，再低声试探护士'), 'Custom story direction text was not visible in the reading flow', customInputResult);
    assertCondition(customInputStore.phase === 'branch', 'Custom story direction did not move the story into branch consequence phase', customInputStore);
    assertCondition(customInputStore.storyDirection === '让主角先反锁病房门，再低声试探护士', 'Custom story direction was not written into scenarioState.storyDirection', customInputStore);
    assertCondition(customInputStore.selectedChoice?.branchId?.startsWith('custom-'), 'Custom story direction did not create a custom selected choice', customInputStore);
    assertCondition(customInputStore.choiceHistory?.some((choice) => choice.prompt === '让主角先反锁病房门，再低声试探护士'), 'Custom story direction was not written into choiceHistory', customInputStore);
    assertCondition(customInputStore.branches?.some((branch) => branch.source === 'custom' && branch.status === 'chosen'), 'Custom story direction did not create a chosen custom branch', customInputStore);
    assertCondition(customInputStore.messages?.some((message) => message.storyChoiceSelection?.branchId === '__custom_story_branch'), 'Custom story direction was not persisted as a storyChoiceSelection message', customInputStore);
    assertCondition(!customInputStore.messages?.some((message) => message.type === 'god' && message.content.includes('让主角先反锁病房门')), 'Custom story direction leaked into ordinary director messages', customInputStore);

    const longFlowConsoleLeaks = findForbiddenNormalConsoleLeaks(cdp.events);
    assertCondition(longFlowConsoleLeaks.length === 0, 'Developer-only story console logs leaked in normal story UI flow', longFlowConsoleLeaks);

    const errors = cdp.events
      .filter((event) => event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded')
      .map((event) => event.params)
      .filter((entry) => entry?.level === 'error' || entry?.exceptionDetails);
    assertCondition(errors.length === 0, 'Browser reported runtime errors during story smoke', errors);

    console.log(JSON.stringify({
      ok: true,
      url: CLIENT_URL,
      cdp: CDP_URL,
      before: {
        messageTypes: before.messageTypes,
        buttons: before.buttons.filter((button) => button.includes('让')),
        contextMenuItems: contextMenu.menuItems,
      },
      afterReturn: {
        messageIds: afterReturn.messageIds,
        buttons: afterReturn.buttons.filter((button) => button.includes('让')),
      },
      after: {
        messageTypes: after.messageTypes,
        messageIds: after.messageIds,
        liveRevealBottomDistance: liveRevealDone.bottomDistance,
      },
      customInput: {
        phase: customInputStore.phase,
        storyDirection: customInputStore.storyDirection,
        choiceHistoryCount: customInputStore.choiceHistory?.length || 0,
      },
      longFlow: {
        phase: longFlowAfterSecondChoice.phase,
        storyDirection: longFlowAfterSecondChoice.storyDirection,
        choiceHistoryCount: longFlowAfterSecondChoice.choiceHistory?.length || 0,
      },
    }, null, 2));
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
