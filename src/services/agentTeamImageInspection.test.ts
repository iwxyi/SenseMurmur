import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateResponse } from './aiClient';
import { inspectAgentTeamImages } from './agentTeamImageInspection';

vi.mock('./aiClient', () => ({ generateResponse: vi.fn() }));

const params = () => ({
  api: { provider: 'openai' as const, apiKey: 'test', baseUrl: '', model: 'gpt-4o' },
  goal: '检查场景', acceptance: '有森林',
  references: [{ url: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' }],
  signal: new AbortController().signal,
});

beforeEach(() => vi.mocked(generateResponse).mockReset());

describe('agent team image inspection', () => {
  it('passes the actual image as an attachment to the vision model', async () => {
    vi.mocked(generateResponse).mockResolvedValue('画面有森林，但未见角色。');
    expect(await inspectAgentTeamImages(params())).toBe('画面有森林，但未见角色。');
    expect(generateResponse).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('实际收到的图片'),
      [expect.objectContaining({ attachments: [{ url: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' }] })],
      undefined, expect.objectContaining({ responseFormat: 'text' }));
  });

  it('rejects missing and unsupported image references before calling the model', async () => {
    await expect(inspectAgentTeamImages({ ...params(), references: [] })).rejects.toThrow('缺少已生成');
    await expect(inspectAgentTeamImages({ ...params(), references: [{ url: 'http://example.test/image.png' }] })).rejects.toThrow('地址不可用于');
    expect(generateResponse).not.toHaveBeenCalled();
  });

  it('rejects an empty inspection result', async () => {
    vi.mocked(generateResponse).mockResolvedValue('  ');
    await expect(inspectAgentTeamImages(params())).rejects.toThrow('没有返回有效结果');
  });
});
