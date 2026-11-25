import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantArtifactStore } from './useAssistantArtifactStore';

const apiMocks = vi.hoisted(() => ({
  upsertAssistantArtifact: vi.fn(),
  upsertAssistantArtifacts: vi.fn(),
  getAssistantArtifacts: vi.fn(),
  getSyncChanges: vi.fn(),
}));

vi.mock('../services/api', () => ({ api: apiMocks }));
vi.mock('../services/cloudSyncPreference', () => ({ isCloudSyncEnabled: () => true }));
vi.mock('../services/assistantArtifactCloudSyncPreference', () => ({ isAssistantArtifactCloudSyncEnabled: () => true }));

describe('useAssistantArtifactStore', () => {
  const localStorageMock = (() => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    };
  })();

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true });
    localStorage.clear();
    apiMocks.upsertAssistantArtifact.mockReset();
    apiMocks.upsertAssistantArtifacts.mockReset();
    apiMocks.getAssistantArtifacts.mockReset();
    apiMocks.getSyncChanges.mockReset();
    localStorage.setItem('pneumata-auth-mode', 'cloud');
    useAssistantArtifactStore.setState({ items: [] });
  });

  it('does not merge new artifacts by title without an explicit update target', () => {
    const store = useAssistantArtifactStore.getState();
    store.commitPatchSet({
      chatId: 'chat-a',
      messageId: 'message-a',
      timestamp: 100,
      patches: [{
        action: 'create',
        kind: 'diagram',
        title: '流程图',
        language: 'mermaid',
        content: 'flowchart TD\nA-->B',
      }, {
        action: 'create',
        kind: 'diagram',
        title: '流程图',
        language: 'mermaid',
        content: 'flowchart TD\nC-->D',
      }],
    });

    const artifacts = useAssistantArtifactStore.getState().getArtifactsForChat('chat-a');
    expect(artifacts).toHaveLength(2);
    expect(artifacts.every((artifact) => artifact.versions.length === 1)).toBe(true);
  });

  it('adds a new version only when update specifies an existing artifact id', () => {
    const store = useAssistantArtifactStore.getState();
    const [created] = store.commitPatchSet({
      chatId: 'chat-a',
      messageId: 'message-a',
      timestamp: 100,
      patches: [{
        action: 'create',
        kind: 'diagram',
        title: '流程图',
        language: 'mermaid',
        content: 'flowchart TD\nA-->B',
      }],
    });
    useAssistantArtifactStore.getState().commitPatchSet({
      chatId: 'chat-a',
      messageId: 'message-b',
      timestamp: 200,
      patches: [{
        action: 'update',
        artifactId: created.id,
        kind: 'diagram',
        title: '流程图',
        language: 'mermaid',
        content: 'flowchart TD\nA-->B-->C',
        baseVersionId: created.currentVersionId,
      }],
    });

    const artifacts = useAssistantArtifactStore.getState().getArtifactsForChat('chat-a');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].versions).toHaveLength(2);
  });

  it('restores a selected version and trims later versions', () => {
    const store = useAssistantArtifactStore.getState();
    const [created] = store.commitPatchSet({ chatId: 'chat-version', messageId: 'm1', timestamp: 100, patches: [{ action: 'create', kind: 'document', title: '文档', content: 'v1' }] });
    useAssistantArtifactStore.getState().commitPatchSet({ chatId: 'chat-version', messageId: 'm2', timestamp: 200, patches: [{ action: 'update', artifactId: created.id, kind: 'document', title: '文档', content: 'v2', baseVersionId: created.currentVersionId }] });
    const current = useAssistantArtifactStore.getState().getArtifactsForChat('chat-version')[0];
    const firstVersionId = current.versions[0].id;
    const result = useAssistantArtifactStore.getState().applyVersionOperations({ chatId: 'chat-version', operations: [{ kind: 'restore', artifactId: created.id, versionId: firstVersionId }] });
    expect(result.results[0]?.error).toBeUndefined();
    const restored = useAssistantArtifactStore.getState().getArtifactsForChat('chat-version')[0];
    expect(restored.currentVersionId).toBe(firstVersionId);
    expect(restored.versions).toHaveLength(1);
  });

  it('merges server revision after a cloud push', async () => {
    const [created] = useAssistantArtifactStore.getState().commitPatchSet({
      chatId: 'chat-a',
      messageId: 'message-a',
      timestamp: 100,
      patches: [{
        action: 'create',
        kind: 'document',
        title: '报告',
        content: '# 报告',
      }],
    });
    apiMocks.upsertAssistantArtifact.mockResolvedValueOnce({
      accepted: true,
      status: 'accepted',
      item: { ...created, revision: 7, updatedAt: 120 },
    });

    await useAssistantArtifactStore.getState().pushArtifactsToCloud('chat-a', [created.id]);

    expect(apiMocks.upsertAssistantArtifact).toHaveBeenCalledWith(expect.objectContaining({
      id: created.id,
      baseRevision: null,
      operationId: expect.stringContaining(created.id),
    }));
    expect(useAssistantArtifactStore.getState().items.find((item) => item.id === created.id)?.revision).toBe(7);
  });

  it('reconciles a lost cloud response without writing an already saved workflow version twice', async () => {
    const store = useAssistantArtifactStore.getState();
    const [created] = store.commitPatchSet({
      chatId: 'chat-a', messageId: 'workflow-output', timestamp: 100,
      patches: [{ action: 'create', kind: 'document', title: '报告', content: '# 报告' }],
    });
    apiMocks.getAssistantArtifacts.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: [created] });
    apiMocks.upsertAssistantArtifact.mockRejectedValueOnce(new Error('连接中断'));

    await expect(store.confirmWorkflowArtifactsInCloud('chat-a', [created.id])).rejects.toThrow('连接中断');
    await expect(store.confirmWorkflowArtifactsInCloud('chat-a', [created.id])).resolves.toBeUndefined();
    expect(apiMocks.upsertAssistantArtifact).toHaveBeenCalledTimes(1);
  });

  it('reports a cloud conflict when the workflow version is absent from the write response', async () => {
    const store = useAssistantArtifactStore.getState();
    const [created] = store.commitPatchSet({
      chatId: 'chat-a', messageId: 'workflow-output', timestamp: 100,
      patches: [{ action: 'create', kind: 'document', title: '报告', content: '# 报告' }],
    });
    apiMocks.getAssistantArtifacts.mockResolvedValueOnce({ items: [] });
    apiMocks.upsertAssistantArtifact.mockResolvedValueOnce({ accepted: false, item: { ...created, versions: [] } });
    await expect(store.confirmWorkflowArtifactsInCloud('chat-a', [created.id])).rejects.toThrow('云端未确认保存产物版本');
    expect(store.getArtifactsForChat('chat-a')[0].versions).toEqual(created.versions);
  });

  it('refreshes cloud artifacts through sync changes with all versions', async () => {
    apiMocks.getSyncChanges.mockResolvedValueOnce({
      status: 'modified',
      scope: 'assistant-artifacts:chat-a',
      cursor: 'log:9',
      revision: 'log:9',
      changes: [{
        op: 'upsert',
        entity: 'assistant_artifact',
        id: 'artifact-a',
        revision: 4,
        patch: {
          id: 'artifact-a',
          chatId: 'chat-a',
          kind: 'diagram',
          title: '流程图',
          language: 'mermaid',
          currentVersionId: 'artifact-a:v:2',
          versions: [{
            id: 'artifact-a:v:1',
            artifactId: 'artifact-a',
            content: 'flowchart TD\nA-->B',
            language: 'mermaid',
            sourceMessageId: 'message-a',
            createdAt: 100,
          }, {
            id: 'artifact-a:v:2',
            artifactId: 'artifact-a',
            content: 'flowchart TD\nA-->B-->C',
            language: 'mermaid',
            sourceMessageId: 'message-b',
            baseVersionId: 'artifact-a:v:1',
            createdAt: 200,
          }],
          sourceMessageId: 'message-b',
          createdAt: 100,
          updatedAt: 200,
          deletedAt: null,
          revision: 4,
        },
      }],
      hasMore: false,
    });

    await useAssistantArtifactStore.getState().refreshArtifactsFromCloud('chat-a');

    const [artifact] = useAssistantArtifactStore.getState().getArtifactsForChat('chat-a');
    expect(apiMocks.getSyncChanges).toHaveBeenCalledWith({ scope: 'assistant-artifacts:chat-a', since: null });
    expect(apiMocks.getAssistantArtifacts).not.toHaveBeenCalled();
    expect(artifact?.versions).toHaveLength(2);
    expect(artifact?.currentVersionId).toBe('artifact-a:v:2');
  });

  it('falls back to the legacy artifact endpoint when sync changes are unavailable', async () => {
    apiMocks.getSyncChanges.mockRejectedValueOnce(new Error('unsupported scope'));
    apiMocks.getAssistantArtifacts.mockResolvedValueOnce({
      serverTime: 300,
      items: [{
        id: 'artifact-a',
        chatId: 'chat-a',
        kind: 'document',
        title: '报告',
        currentVersionId: 'artifact-a:v:1',
        versions: [{
          id: 'artifact-a:v:1',
          artifactId: 'artifact-a',
          content: '# 报告',
          sourceMessageId: 'message-a',
          createdAt: 100,
        }],
        sourceMessageId: 'message-a',
        createdAt: 100,
        updatedAt: 200,
        deletedAt: null,
        revision: 2,
      }],
    });

    await useAssistantArtifactStore.getState().refreshArtifactsFromCloud('chat-a');

    expect(apiMocks.getAssistantArtifacts).toHaveBeenCalledWith('chat-a');
    expect(useAssistantArtifactStore.getState().getArtifactsForChat('chat-a')[0]?.revision).toBe(2);
  });

  it('creates an image artifact from a ready assistant media asset reference', () => {
    const message = {
      id: 'message-image',
      chatId: 'chat-a',
      type: 'ai',
      senderId: 'assistant',
      senderName: '助手',
      content: '图片已生成',
      emotion: 0,
      timestamp: 100,
      isDeleted: false,
    } as const;
    const item = useAssistantArtifactStore.getState().createImageArtifactFromAttachment({
      chatId: 'chat-a',
      message,
      attachment: {
        id: 'image-1',
        kind: 'image',
        status: 'ready',
        altText: '流程图预览图',
        assetId: 'asset-1',
        url: '/uploads/media/u/chat/image.png',
        mimeType: 'image/png',
        sizeBytes: 1234,
        createdAt: 100,
        updatedAt: 120,
      },
      timestamp: 130,
    });

    expect(item?.kind).toBe('image');
    expect(item?.versions[0]?.media?.[0]).toMatchObject({ assetId: 'asset-1', mimeType: 'image/png' });
    expect(useAssistantArtifactStore.getState().getArtifactsForChat('chat-a')).toHaveLength(1);
  });

  it('does not append duplicate image artifact versions for the same asset', () => {
    const message = {
      id: 'message-image',
      chatId: 'chat-a',
      type: 'ai',
      senderId: 'assistant',
      senderName: '助手',
      content: '图片已生成',
      emotion: 0,
      timestamp: 100,
      isDeleted: false,
    } as const;
    const attachment = {
      id: 'image-1',
      kind: 'image' as const,
      status: 'ready' as const,
      altText: '图片产物',
      assetId: 'asset-1',
      url: '/uploads/media/u/chat/image.png',
      mimeType: 'image/png',
      sizeBytes: 1234,
      createdAt: 100,
      updatedAt: 120,
    };

    const first = useAssistantArtifactStore.getState().createImageArtifactFromAttachment({
      chatId: 'chat-a',
      message,
      attachment,
      timestamp: 130,
    });
    const second = useAssistantArtifactStore.getState().createImageArtifactFromAttachment({
      chatId: 'chat-a',
      message,
      attachment,
      timestamp: 140,
    });

    expect(second?.id).toBe(first?.id);
    expect(second?.versions).toHaveLength(1);
  });

  it('overwrites the current autosave and promotes it on submit', () => {
    const [created] = useAssistantArtifactStore.getState().commitPatchSet({
      chatId: 'chat-a',
      messageId: 'message-html',
      timestamp: 100,
      patches: [{
        action: 'create',
        kind: 'html',
        title: '练习',
        content: '<form><input name="answer"></form>',
      }],
    });

    const firstAutosave = useAssistantArtifactStore.getState().saveHtmlInteractionState({
      artifactId: created.id,
      baseVersionId: created.currentVersionId,
      interactionState: { answer: 'A' },
      timestamp: 200,
    });
    const secondAutosave = useAssistantArtifactStore.getState().saveHtmlInteractionState({
      artifactId: created.id,
      baseVersionId: created.currentVersionId,
      interactionState: { answer: 'B' },
      timestamp: 300,
    });

    expect(firstAutosave?.versions).toHaveLength(2);
    expect(secondAutosave?.versions).toHaveLength(2);
    expect(secondAutosave?.currentVersionId).toBe(firstAutosave?.currentVersionId);
    expect(secondAutosave?.versions.at(-1)).toMatchObject({
      stage: 'autosave',
      interactionState: { answer: 'B' },
      revision: 2,
    });

    const submitted = useAssistantArtifactStore.getState().submitHtmlInteraction({
      artifactId: created.id,
      baseVersionId: created.currentVersionId,
      interactionState: { answer: 'B' },
      submissionId: 'submission-1',
      timestamp: 400,
    });

    expect(submitted?.versions).toHaveLength(2);
    expect(submitted?.currentVersionId).toBe(firstAutosave?.currentVersionId);
    expect(submitted?.versions.at(-1)).toMatchObject({
      stage: 'submitted',
      interactionState: { answer: 'B' },
      submissionId: 'submission-1',
    });
  });

  it('starts a new autosave after a submitted version', () => {
    const [created] = useAssistantArtifactStore.getState().commitPatchSet({
      chatId: 'chat-a',
      messageId: 'message-html',
      timestamp: 100,
      patches: [{ action: 'create', kind: 'html', title: '练习', content: '<form></form>' }],
    });
    const submitted = useAssistantArtifactStore.getState().submitHtmlInteraction({
      artifactId: created.id,
      baseVersionId: created.currentVersionId,
      interactionState: { answer: 'A' },
      submissionId: 'submission-1',
      timestamp: 200,
    });
    const next = useAssistantArtifactStore.getState().saveHtmlInteractionState({
      artifactId: created.id,
      baseVersionId: submitted!.currentVersionId,
      interactionState: { answer: 'C' },
      timestamp: 300,
    });

    expect(next?.versions).toHaveLength(3);
    expect(next?.versions.at(-1)).toMatchObject({ stage: 'autosave', interactionState: { answer: 'C' } });
  });
});
