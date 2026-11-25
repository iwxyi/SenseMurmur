import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateResponse } from './aiClient';
import { api } from './api';
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

  it('compares actual key frames with the upstream scene and continuity brief', async () => {
    vi.mocked(generateResponse).mockResolvedValue('第一张是庭院，第二张变成街道，剧本未写转场。');
    await inspectAgentTeamImages({ ...params(), sourceText: '剧本：三镜头始终位于同一座绿意庭院，黄昏暖光。' });
    const request = vi.mocked(generateResponse).mock.calls[0];
    expect(request[1]).toContain('跨图不连续');
    expect(request[2][0].content).toContain('三镜头始终位于同一座绿意庭院');
    expect(request[2][0].content).toContain('仅用于对照');
  });

  it('combines references when the vision model accepts only one image', async () => {
    const context = { fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn(), fillStyle: '', font: '' };
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => context,
      toDataURL: () => 'data:image/jpeg;base64,Y29udGFjdC1zaGVldA==' }) });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 100, height: 80, close: vi.fn() })));
    vi.mocked(generateResponse).mockResolvedValue('第一格是森林追逐，第二格是机器猫飞行。');
    const references = [
      { url: 'data:image/png;base64,aGVsbG8=', label: '追逐' },
      { url: 'data:image/png;base64,d29ybGQ=', label: '飞行' },
    ];
    const result = await inspectAgentTeamImages({ ...params(), references, maxAttachments: 1 });
    expect(result).toContain('第一格是森林追逐');
    expect(vi.mocked(generateResponse)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateResponse).mock.calls[0][2][0].attachments).toEqual([
      { url: 'data:image/jpeg;base64,Y29udGFjdC1zaGVldA==', mimeType: 'image/jpeg' },
    ]);
    expect(vi.mocked(generateResponse).mock.calls[0][2][0].content).toContain('编号联系表，共 2 格');
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
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

  it('reports when reading the generated image fails before vision inspection', async () => {
    vi.spyOn(api, 'fetchWithAuth').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(inspectAgentTeamImages({ ...params(), references: [{ url: '/uploads/media/generated.png' }] }))
      .rejects.toThrow('读取生成图片失败（后端媒体文件）：网络请求未能建立');
    expect(api.fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining('/api/media-assets/content?url=%2Fuploads%2Fmedia%2Fgenerated.png'), expect.anything());
    expect(generateResponse).not.toHaveBeenCalled();
  });

  it('reports a network failure from the vision model separately from image loading', async () => {
    vi.mocked(generateResponse).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(inspectAgentTeamImages(params()))
      .rejects.toThrow('图片已读取，但调用视觉检查模型失败（openai/gpt-4o）：网络请求未能建立');
  });
});
