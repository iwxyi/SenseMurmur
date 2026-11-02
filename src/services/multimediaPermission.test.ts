import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { assertMultimediaGenerationPermission, reportMultimediaPermissionError, useMultimediaPermissionDialog } from './multimediaPermission';
import { generateVideoWithAdapter } from './aiGenerationAdapter';
import { DEFAULT_IMAGE_AI_PROFILE } from '../types/settings';

describe('multimedia permission actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useMultimediaPermissionDialog.getState().close();
  });

  it('stays silent before an explicit action', () => {
    expect(useMultimediaPermissionDialog.getState().message).toBeNull();
  });

  it('blocks video submission and shows a dialog without changing the profile', async () => {
    vi.spyOn(api, 'getBillingMembership').mockResolvedValue({
      vipActive: false, activeSubscription: null, latestSubscription: null, recentOrders: [],
    });
    const submit = vi.spyOn(api, 'generateAiMedia');
    const profile = { ...DEFAULT_IMAGE_AI_PROFILE, type: 'video' as const };
    await expect(generateVideoWithAdapter({ profile, prompt: 'a tea cup' })).rejects.toThrow('多媒体生成权限');
    expect(submit).not.toHaveBeenCalled();
    expect(profile.type).toBe('video');
    expect(useMultimediaPermissionDialog.getState().message).toContain('多媒体生成权限');
  });

  it('allows newly granted access and rechecks a later revocation', async () => {
    vi.spyOn(api, 'getBillingMembership').mockResolvedValue({
      vipActive: false, activeSubscription: null, latestSubscription: null, recentOrders: [],
    });
    const membership = await api.getBillingMembership();
    vi.mocked(api.getBillingMembership).mockResolvedValue({
      ...membership,
      vipEntitlement: { tierCode: 'free', entitlement: { multimediaGenerationEnabled: true } as NonNullable<typeof membership.vipEntitlement>['entitlement'] },
    });
    await expect(assertMultimediaGenerationPermission()).resolves.toBeUndefined();
    vi.mocked(api.getBillingMembership).mockResolvedValue(membership);
    await expect(assertMultimediaGenerationPermission()).rejects.toThrow('多媒体生成权限');
  });

  it('reports a server rejection if permission changes after the preflight', () => {
    reportMultimediaPermissionError(new ApiError('权限已撤销', { code: 'MULTIMEDIA_GENERATION_FORBIDDEN', status: 403 }));
    expect(useMultimediaPermissionDialog.getState().message).toBe('权限已撤销');
  });
});
