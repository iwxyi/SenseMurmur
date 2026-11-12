import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateResponse } from './aiClient';
import { sampleVideoInspectionFrames } from './videoInspectionFrames';
import { inspectAgentTeamVideo } from './agentTeamVideoInspection';
import { WorkflowPreflightError } from './workflowRunRuntime';

vi.mock('./aiClient', () => ({ generateResponse: vi.fn() }));
vi.mock('./videoInspectionFrames', () => ({ sampleVideoInspectionFrames: vi.fn() }));

const params = () => ({ api: { provider: 'openai' as const, apiKey: 'test', baseUrl: '', model: 'gpt-4o' },
  chatId: 'chat', goal: '检查追逐画面', acceptance: '角色清晰', url: 'data:video/mp4;base64,fixture', maxFrames: 2, signal: new AbortController().signal });

beforeEach(() => {
  vi.mocked(generateResponse).mockReset();
  vi.mocked(sampleVideoInspectionFrames).mockReset();
  vi.mocked(sampleVideoInspectionFrames).mockResolvedValue({ durationSeconds: 4, width: 1280, height: 720,
    frames: [{ timeSeconds: 1, url: 'data:image/jpeg;base64,first' }, { timeSeconds: 3, url: 'data:image/jpeg;base64,last' }] });
});

describe('video frame inspection', () => {
  it('sends actual ordered image attachments and preserves the observation scope', async () => {
    vi.mocked(generateResponse).mockResolvedValue('角色出现在两张画面中。');
    const output = await inspectAgentTeamVideo(params());
    expect(sampleVideoInspectionFrames).toHaveBeenCalledWith(expect.objectContaining({ maxFrames: 2, url: params().url }));
    expect(generateResponse).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('不能声称观看完整视频'),
      [expect.objectContaining({ content: expect.stringContaining('1.00 秒、3.00 秒'), attachments: [
        { url: 'data:image/jpeg;base64,first', mimeType: 'image/jpeg' }, { url: 'data:image/jpeg;base64,last', mimeType: 'image/jpeg' },
      ] })], undefined, expect.objectContaining({ responseFormat: 'text' }));
    expect(output).toContain('未检查音轨或逐帧连续性');
    expect(output).toContain('1280×720');
  });

  it('fails before calling a paid model when the saved video cannot decode', async () => {
    vi.mocked(sampleVideoInspectionFrames).mockRejectedValue(new Error('无法解码检查视频'));
    await expect(inspectAgentTeamVideo(params())).rejects.toBeInstanceOf(WorkflowPreflightError);
    expect(generateResponse).not.toHaveBeenCalled();
  });

  it('does not submit a model call after sampling was cancelled', async () => {
    const controller = new AbortController();
    vi.mocked(sampleVideoInspectionFrames).mockImplementation(async () => {
      controller.abort(new Error('停止'));
      return { durationSeconds: 1, width: 1, height: 1, frames: [] };
    });
    await expect(inspectAgentTeamVideo({ ...params(), signal: controller.signal })).rejects.toThrow('停止');
    expect(generateResponse).not.toHaveBeenCalled();
  });

  it('rejects empty model output after the model was called', async () => {
    vi.mocked(generateResponse).mockResolvedValue('  ');
    await expect(inspectAgentTeamVideo(params())).rejects.toThrow('没有返回有效结果');
    expect(generateResponse).toHaveBeenCalledTimes(1);
  });
});
