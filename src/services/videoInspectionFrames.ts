import { fetchMediaAssetContent } from './mediaAssetContent';

const MAX_VIDEO_BYTES = 128 * 1024 * 1024;

export function videoInspectionSampleTimes(duration: number, count: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('视频检查仅支持时长不超过 10 分钟的有限视频');
  if (!Number.isSafeInteger(count) || count < 1 || count > 6) throw new Error('视频抽帧数量须为 1 到 6');
  return Array.from({ length: count }, (_, index) => duration * (index + 0.5) / count);
}

async function inspectionSource(url: string, signal: AbortSignal): Promise<{ url: string; release?: () => void }> {
  if (/^data:video\/[a-z0-9.+-]+;base64,/i.test(url)) {
    if (url.length > Math.ceil(MAX_VIDEO_BYTES * 4 / 3) + 100) throw new Error('视频文件超过 128 MiB 检查上限');
    return { url };
  }
  const local = url.startsWith('/uploads/media/');
  if (!local && !/^https:\/\//i.test(url) && !url.startsWith('blob:')) throw new Error('视频文件地址不可用于检查');
  const response = await fetchMediaAssetContent(url, 'video', signal);
  if (!response.ok) throw new Error(`读取检查视频失败（HTTP ${response.status}）`);
  if (!response.body || Number(response.headers.get('content-length')) > MAX_VIDEO_BYTES) throw new Error('视频文件为空或超过 128 MiB 检查上限');
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_VIDEO_BYTES) throw new Error('视频文件超过 128 MiB 检查上限');
      chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  } finally { reader.releaseLock(); }
  if (!size) throw new Error('检查视频文件为空');
  const objectUrl = URL.createObjectURL(new Blob(chunks, { type: response.headers.get('content-type') || 'video/mp4' }));
  return { url: objectUrl, release: () => URL.revokeObjectURL(objectUrl) };
}

function waitForVideo(video: HTMLVideoElement, event: 'loadeddata' | 'seeked', signal: AbortSignal, start: () => void) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      video.removeEventListener(event, ready);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error('无法解码检查视频，请确认文件可播放且格式受当前设备支持'));
    const aborted = () => finish(signal.reason || new Error('视频检查已取消'));
    const timer = setTimeout(() => finish(new Error('读取视频画面超时，请检查文件后重试检查')), 20_000);
    video.addEventListener(event, ready, { once: true });
    video.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else { try { start(); } catch (error) { finish(error); } }
  });
}

export async function sampleVideoInspectionFrames(params: { url: string; maxFrames: number; signal: AbortSignal }) {
  params.signal.throwIfAborted();
  videoInspectionSampleTimes(1, params.maxFrames);
  if (typeof document === 'undefined') throw new Error('当前设备不支持视频画面检查');
  const source = await inspectionSource(params.url, params.signal);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    await waitForVideo(video, 'loadeddata', params.signal, () => { video.src = source.url; video.load(); });
    const times = videoInspectionSampleTimes(video.duration, params.maxFrames);
    if (!video.videoWidth || !video.videoHeight || video.videoWidth * video.videoHeight > 4096 * 4096) throw new Error('视频画面尺寸无效或超过当前检查容量');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 768 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('此设备无法读取视频画面');
    const frames: Array<{ timeSeconds: number; url: string }> = [];
    for (const time of times) {
      await waitForVideo(video, 'seeked', params.signal, () => { video.currentTime = time; });
      params.signal.throwIfAborted();
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ timeSeconds: time, url: canvas.toDataURL('image/jpeg', 0.8) });
    }
    if (frames.reduce((size, frame) => size + frame.url.length, 0) > 8 * 1024 * 1024) throw new Error('抽取画面超过模型请求大小上限');
    return { durationSeconds: video.duration, width: video.videoWidth, height: video.videoHeight, frames };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    source.release?.();
  }
}
