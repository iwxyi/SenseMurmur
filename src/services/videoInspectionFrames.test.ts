import { describe, expect, it } from 'vitest';
import { sampleVideoInspectionFrames, videoInspectionSampleTimes } from './videoInspectionFrames';

describe('video inspection sampling', () => {
  it('samples ordered midpoint frames without seeking beyond either endpoint', () => {
    expect(videoInspectionSampleTimes(12, 6)).toEqual([1, 3, 5, 7, 9, 11]);
    expect(videoInspectionSampleTimes(0.2, 1)).toEqual([0.1]);
  });

  it.each([0, -1, Infinity, NaN, 601])('rejects unsupported duration %s', (duration) => {
    expect(() => videoInspectionSampleTimes(duration, 3)).toThrow('时长');
  });

  it.each([0, 7, 1.5, NaN])('rejects unsupported frame count %s', (count) => {
    expect(() => videoInspectionSampleTimes(12, count)).toThrow('数量');
  });

  it('rejects cancellation before reading any file', async () => {
    const controller = new AbortController();
    controller.abort(new Error('已停止检查'));
    await expect(sampleVideoInspectionFrames({ url: 'https://example.test/video.mp4', maxFrames: 3, signal: controller.signal })).rejects.toThrow('已停止检查');
  });
});
