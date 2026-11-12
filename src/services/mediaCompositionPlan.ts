export interface MediaCompositionPlan {
  clips: Array<{ taskId: string; startSeconds?: number; durationSeconds?: number }>;
  audioTracks?: Array<{ taskId: string; volume?: number; offsetSeconds?: number; loop?: boolean }>;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  originalAudioVolume?: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('音视频合成配置无效');
  return value as Record<string, unknown>;
}

function number(value: unknown, min: number, max: number, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}无效`);
  return value;
}

function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(value)) throw new Error('合成素材任务 ID 无效');
  return value;
}

export function validateMediaCompositionPlan(raw: unknown): MediaCompositionPlan {
  const value = object(raw);
  if (!Array.isArray(value.clips) || value.clips.length < 1 || value.clips.length > 48) throw new Error('合成需提供 1 到 48 个有序视频片段');
  if (value.audioTracks !== undefined && (!Array.isArray(value.audioTracks) || value.audioTracks.length > 4)) throw new Error('合成最多叠加 4 条音轨');
  if (value.aspectRatio !== undefined && !['16:9', '9:16', '1:1'].includes(String(value.aspectRatio))) throw new Error('合成画面比例无效');
  return {
    clips: value.clips.map((rawClip) => {
      const clip = object(rawClip);
      return { taskId: taskId(clip.taskId), startSeconds: number(clip.startSeconds, 0, 600, '片段起点'), durationSeconds: number(clip.durationSeconds, 0.05, 600, '片段时长') };
    }),
    audioTracks: (value.audioTracks as unknown[] | undefined)?.map((rawTrack) => {
      const track = object(rawTrack);
      if (track.loop !== undefined && typeof track.loop !== 'boolean') throw new Error('音轨循环参数无效');
      return { taskId: taskId(track.taskId), volume: number(track.volume, 0, 2, '音轨音量'), offsetSeconds: number(track.offsetSeconds, 0, 600, '音轨偏移'), loop: track.loop as boolean | undefined };
    }),
    aspectRatio: value.aspectRatio as MediaCompositionPlan['aspectRatio'],
    originalAudioVolume: number(value.originalAudioVolume, 0, 2, '原声音量'),
  };
}
