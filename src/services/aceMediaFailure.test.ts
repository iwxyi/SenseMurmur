import { describe, expect, it } from 'vitest';
import { formatAceMediaFailure } from './aceMediaFailure';

describe('formatAceMediaFailure', () => {
  it('renders safe request values and model constraints beside a generic upstream error', () => {
    expect(formatAceMediaFailure('ACE 任务生成失败：错误码 bad_request，视频输入参数无效', {
      model: 'doubao-seedance-2-0-fast-260128', endpoint: 'POST /seedance/videos', requestId: 'a1b2c3d4e5f6',
      fields: ['async', 'content', 'duration', 'model', 'ratio', 'resolution'],
      values: { ratio: '16:9', resolution: '720p', duration: 15, async: true },
      promptCharacters: 642, promptUtf8Bytes: 1480, promptMaxLength: 1000, imageCount: 0,
      allowedValues: { ratio: ['16:9', '9:16'], resolution: ['480p', '720p'] },
      durationConstraints: { minimum: 4, maximum: 15 },
      parameters: [
        { name: 'generate_audio', value: true, defaultValue: true },
        { name: 'priority', value: 'normal', allowedValues: ['normal', 'high'] },
      ],
      contentTypes: [{ type: 'text' }, { type: 'image_url', role: 'reference_image' }],
    })).toBe('ACE 任务生成失败：错误码 bad_request，视频输入参数无效。请求诊断：模型 doubao-seedance-2-0-fast-260128；接口 POST /seedance/videos；实际参数 async, content, duration, model, ratio, resolution；内容类型 text/image_url(reference_image)；比例 16:9；分辨率 720p；时长 15 秒；异步 true；generate_audio=true，模型默认 true；priority=normal，允许值 normal/high；提示词 642 字符，模型上限 1000 字符，UTF-8 1480 字节；参考图 0 张；比例可选值 16:9/9:16；分辨率可选值 480p/720p；模型时长范围 4-15 秒；请求标识 a1b2c3d4e5f6。');
  });

  it('does not render untrusted diagnostic text or change errors without diagnostics', () => {
    expect(formatAceMediaFailure('任务失败', { model: 'bad model', endpoint: 'POST https://private.example', fields: ['prompt\nsecret'], values: { ratio: '16:9\nsecret' } })).toBe('任务失败');
    expect(formatAceMediaFailure('任务失败', null)).toBe('任务失败');
  });
});
