import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { composeAgentTeamMedia, syncAgentTeamCompositionToCloud } from './agentTeamMediaComposition';
import type { MediaCompositionPlan } from './mediaCompositionPlan';

const state = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  upsertMessage: vi.fn(),
  waitForMessageCloudConfirmation: vi.fn(),
  uploadLocalMessageMediaToCloud: vi.fn(),
  isLocalOnlyMediaMode: vi.fn(),
}));

vi.mock('../stores/useMessageStore', () => ({
  useMessageStore: { getState: () => ({ ...state, messageWindowsByChatId: {} }) },
}));
vi.mock('../stores/useChatStore', () => ({ useChatStore: { getState: () => ({ chats: [] }) } }));
vi.mock('./agentTeamConversation', () => ({ advanceTeamConversation: vi.fn(), teamConversationContext: vi.fn() }));
vi.mock('./messageCloudConfirmation', () => ({ waitForMessageCloudConfirmation: state.waitForMessageCloudConfirmation }));
vi.mock('./richMessageMedia', () => ({
  uploadLocalMessageMediaToCloud: state.uploadLocalMessageMediaToCloud,
  isLocalOnlyMediaMode: state.isLocalOnlyMediaMode,
}));
vi.mock('./chatExecutionLease', () => ({ assertChatExecutionLease: vi.fn() }));

const attachment = { id: 'attachment', kind: 'video', status: 'ready', url: 'data:video/mp4;base64,AAAA' };
const local = { id: 'local', chatId: 'chat', metadata: { agentTeamMedia: { runId: 'run', taskId: 'compose' }, attachments: [attachment] } };
const cloud = { ...local, serverId: 'server', metadata: { ...local.metadata, attachments: [{ ...attachment, url: undefined }] } };

beforeEach(() => {
  vi.resetAllMocks();
  state.messages = [local];
  state.waitForMessageCloudConfirmation.mockResolvedValue(cloud);
});

describe('team composition file synchronization', () => {
  it('publishes existing composed bytes under the original message and attachment', async () => {
    const metadata = { ...cloud.metadata, attachments: [{ ...attachment, url: '/uploads/media/composition.mp4' }] };
    state.uploadLocalMessageMediaToCloud.mockResolvedValue(metadata);
    const signal = new AbortController().signal;
    await syncAgentTeamCompositionToCloud('run', 'compose', signal);
    expect(state.uploadLocalMessageMediaToCloud).toHaveBeenCalledWith({ localMessage: local, cloudMessage: cloud, signal });
    expect(state.upsertMessage).toHaveBeenCalledWith({ ...cloud, metadata }, { replaceAttachments: true });
  });

  it('keeps an existing composition ready when cloud storage is full', async () => {
    state.uploadLocalMessageMediaToCloud.mockRejectedValue(new ApiError('容量不足', { status: 413, code: 'CLOUD_STORAGE_QUOTA_EXCEEDED' }));
    const result = await composeAgentTeamMedia({
      runId: 'run', taskId: 'compose', chatId: 'chat', plan: { clips: [] } as MediaCompositionPlan,
      resolveTaskId: (id) => id, signal: new AbortController().signal,
    });
    expect(result.output).toContain('云端存储容量不足');
    expect(result.output).toContain('成片可在本机播放');
    expect(state.upsertMessage).not.toHaveBeenCalled();
  });
});
