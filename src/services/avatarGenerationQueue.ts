import type { AIModelProfile } from '../types/settings';
import { generateImageWithAdapter } from './aiGenerationAdapter';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useAuthStore } from '../stores/useAuthStore';
import { api } from './api';
import { logRecoverableError } from './diagnostics';
import { prepareAvatarUploadDataUrl } from '../utils/avatarUpload';
import { assertWorkspaceActive, isWorkspaceActive, onWorkspaceShutdown } from './workspaceLifecycle';

export type AvatarGenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface AvatarGenerationTaskState {
  id: string;
  createdAt: number;
  targetKey: string;
  status: AvatarGenerationStatus;
  error: string | null;
  imageDataUrl: string | null;
  characterId?: string | null;
  accountAvatar?: boolean;
  description?: string;
  negativePrompt?: string;
  seed?: string | number | null;
}

interface AvatarGenerationTask extends AvatarGenerationTaskState {
  errorReporting?: 'queue' | 'caller';
  prompt: string;
  profile: AIModelProfile;
  negativePrompt?: string;
  seed?: string | number | null;
  controller: AbortController | null;
  description?: string;
}

type TaskListener = (state: AvatarGenerationTaskState) => void;
type QueueSummaryListener = (summary: AvatarGenerationQueueSummary) => void;

export interface AvatarGenerationQueueSummary {
  queued: number;
  running: number;
  active: number;
  current?: string;
  recentErrors: AvatarGenerationRecentError[];
}

export interface AvatarGenerationRecentError {
  id: string;
  title: string;
  message: string;
  createdAt: number;
}

class AvatarGenerationQueueService {
  private queue: string[] = [];
  private tasks = new Map<string, AvatarGenerationTask>();
  private listenersByTask = new Map<string, Set<TaskListener>>();
  private listenersByTarget = new Map<string, Set<TaskListener>>();
  private summaryListeners = new Set<QueueSummaryListener>();
  private latestTaskIdByTarget = new Map<string, string>();
  private dismissedErrorIds = new Set<string>();
  private runningTaskId: string | null = null;

  enqueue(profile: AIModelProfile, prompt: string, options: { targetKey: string; characterId?: string | null; accountAvatar?: boolean; negativePrompt?: string; seed?: string | number | null; description?: string; errorReporting?: 'queue' | 'caller' }) {
    assertWorkspaceActive();
    const previous = this.getLatestTaskForTarget(options.targetKey);
    if (previous && (previous.status === 'queued' || previous.status === 'running')) {
      this.cancel(previous.id);
    }

    const id = `avatar-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task: AvatarGenerationTask = {
      id,
      createdAt: Date.now(),
      targetKey: options.targetKey,
      characterId: options.characterId || null,
      accountAvatar: options.accountAvatar === true,
      prompt,
      profile,
      negativePrompt: options.negativePrompt,
      seed: options.seed,
      status: 'queued',
      error: null,
      imageDataUrl: null,
      description: options.description,
      errorReporting: options.errorReporting,
      controller: null,
    };

    this.tasks.set(id, task);
    this.latestTaskIdByTarget.set(options.targetKey, id);
    this.queue.push(id);
    this.emit(task);
    void this.processNext();
    return id;
  }

  getLatestTaskForTarget(targetKey: string) {
    const taskId = this.latestTaskIdByTarget.get(targetKey);
    return taskId ? this.toPublicState(this.tasks.get(taskId)) : null;
  }

  subscribe(taskId: string, listener: TaskListener) {
    return this.subscribeInternal(this.listenersByTask, taskId, listener, this.tasks.get(taskId) || null);
  }

  waitForTask(taskId: string) {
    return new Promise<AvatarGenerationTaskState>((resolve, reject) => {
      let unsubscribe: () => void = () => {};
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
        unsubscribe();
      };
      unsubscribe = this.subscribe(taskId, (state) => {
        if (state.status === 'succeeded') {
          finish(() => resolve(state));
        } else if (state.status === 'failed' || state.status === 'cancelled') {
          finish(() => reject(new Error(state.error || '图片生成失败')));
        }
      });
      if (settled) unsubscribe();
    });
  }

  subscribeTarget(targetKey: string, listener: TaskListener) {
    const current = this.getLatestTaskForTarget(targetKey);
    return this.subscribeInternal(this.listenersByTarget, targetKey, listener, current ? (this.tasks.get(current.id) || null) : null);
  }

  getSummary(): AvatarGenerationQueueSummary {
    let queued = 0;
    let running = 0;
    this.tasks.forEach((task) => {
      if (task.status === 'queued') queued += 1;
      if (task.status === 'running') running += 1;
    });
    return {
      queued,
      running,
      active: queued + running,
      current: this.runningTaskId ? this.tasks.get(this.runningTaskId)?.description : undefined,
      recentErrors: [...this.tasks.values()]
        .filter((task) => task.status === 'failed' && task.error && task.errorReporting !== 'caller' && !this.dismissedErrorIds.has(task.id))
        .map((task) => ({ id: task.id, title: task.description || '图片生成', message: task.error || '图片生成失败', createdAt: task.createdAt }))
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  dismissError(taskId: string) {
    this.dismissedErrorIds.add(taskId);
    const summary = this.getSummary();
    this.summaryListeners.forEach((listener) => listener(summary));
  }

  dismissAllErrors() {
    this.tasks.forEach((task) => {
      if (task.status === 'failed') this.dismissedErrorIds.add(task.id);
    });
    const summary = this.getSummary();
    this.summaryListeners.forEach((listener) => listener(summary));
  }

  subscribeSummary(listener: QueueSummaryListener) {
    this.summaryListeners.add(listener);
    listener(this.getSummary());
    return () => {
      this.summaryListeners.delete(listener);
    };
  }

  cancel(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (task.status === 'queued') {
      this.queue = this.queue.filter((id) => id !== taskId);
      task.status = 'cancelled';
      this.emit(task);
      return;
    }

    if (task.status === 'running' && task.controller) {
      task.controller.abort();
    }
  }

  stopForAccountBoundary() {
    this.queue = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'queued' || task.status === 'running') {
        task.controller?.abort();
        task.status = 'cancelled';
        task.imageDataUrl = null;
        task.error = null;
        this.emit(task);
      }
    }
    this.tasks.clear();
    this.latestTaskIdByTarget.clear();
    this.dismissedErrorIds.clear();
    this.summaryListeners.forEach((listener) => listener(this.getSummary()));
  }

  private subscribeInternal(
    bucketMap: Map<string, Set<TaskListener>>,
    key: string,
    listener: TaskListener,
    task: AvatarGenerationTaskState | AvatarGenerationTask | null,
  ) {
    const bucket = bucketMap.get(key) || new Set<TaskListener>();
    bucket.add(listener);
    bucketMap.set(key, bucket);

    const publicTask = this.toPublicState(task);
    if (publicTask) {
      listener(publicTask);
    }

    return () => {
      const current = bucketMap.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        bucketMap.delete(key);
      }
    };
  }

  private async processNext() {
    if (!isWorkspaceActive()) return;
    if (this.runningTaskId) return;
    const nextTaskId = this.queue.shift();
    if (!nextTaskId) return;

    const task = this.tasks.get(nextTaskId);
    if (!task || task.status !== 'queued') {
      void this.processNext();
      return;
    }

    this.runningTaskId = nextTaskId;
    task.status = 'running';
    task.error = null;
    task.controller = new AbortController();
    this.emit(task);

    try {
      const images = await generateImageWithAdapter({
        profile: task.profile,
        prompt: task.prompt,
        count: 1,
        size: '1024x1024',
        intent: 'character-reference',
        negativePrompt: task.negativePrompt,
        seed: task.seed,
        signal: task.controller.signal,
      });
      const firstImage = images[0];
      task.controller.signal.throwIfAborted();
      if (!firstImage?.dataUrl) {
        throw new Error('No image returned');
      }

      task.imageDataUrl = firstImage.dataUrl;
      task.error = null;

      if (task.characterId) {
        const currentCharacters = useCharacterStore.getState().characters;
        const stillExists = currentCharacters.some((character) => character.id === task.characterId);
        if (stillExists) {
          const avatarForUpload = await prepareAvatarUploadDataUrl(firstImage.dataUrl);
          task.controller.signal.throwIfAborted();
          await api.updateCharacter(task.characterId, {
            avatar: avatarForUpload,
          });
          // `loadCharacters` may retain a fresh summary scope and skip the
          // just-written avatar. Force the authoritative summary merge so
          // historical message bubbles immediately resolve the new avatar.
          await useCharacterStore.getState().refreshCharacterSummaryFromCloud();
        }
      }
      if (task.accountAvatar) {
        const avatarForUpload = await prepareAvatarUploadDataUrl(firstImage.dataUrl);
        task.controller.signal.throwIfAborted();
        await useAuthStore.getState().updateProfile({ avatar: avatarForUpload });
      }

      task.controller.signal.throwIfAborted();
      task.status = 'succeeded';
      this.emit(task);
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      task.status = aborted ? 'cancelled' : 'failed';
      task.error = aborted ? null : (error instanceof Error ? error.message : String(error));
      task.imageDataUrl = null;
      if (!aborted) {
        logRecoverableError({
          location: 'avatar-generation-queue.process',
          error,
          extra: {
            taskId: task.id,
            targetKey: task.targetKey,
            characterId: task.characterId,
            provider: task.profile.provider,
            model: task.profile.model,
            intent: 'character-reference',
          },
        });
      }
      this.emit(task);
    } finally {
      task.controller = null;
      if (this.runningTaskId === task.id) this.runningTaskId = null;
      void this.processNext();
    }
  }

  private emit(task: AvatarGenerationTask) {
    const publicState = this.toPublicState(task);
    if (!publicState) return;
    this.listenersByTask.get(task.id)?.forEach((listener) => listener(publicState));
    this.listenersByTarget.get(task.targetKey)?.forEach((listener) => listener(publicState));
    const summary = this.getSummary();
    this.summaryListeners.forEach((listener) => listener(summary));
  }

  private toPublicState(task?: AvatarGenerationTask | AvatarGenerationTaskState | null): AvatarGenerationTaskState | null {
    if (!task) return null;
    return {
      id: task.id,
      createdAt: task.createdAt,
      targetKey: task.targetKey,
      status: task.status,
      error: task.error,
      imageDataUrl: task.imageDataUrl,
      characterId: task.characterId || null,
      description: task.description,
    };
  }
}

export const avatarGenerationQueue = new AvatarGenerationQueueService();
onWorkspaceShutdown(() => avatarGenerationQueue.stopForAccountBoundary());
