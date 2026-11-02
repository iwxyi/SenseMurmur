import { create } from 'zustand';
import { api, ApiError } from './api';

export const useMultimediaPermissionDialog = create<{
  message: string | null;
  close: () => void;
}>(() => ({ message: null, close: () => useMultimediaPermissionDialog.setState({ message: null }) }));

export function reportMultimediaPermissionError(error: unknown) {
  if (error instanceof ApiError && error.code === 'MULTIMEDIA_GENERATION_FORBIDDEN') {
    useMultimediaPermissionDialog.setState({ message: error.message });
  }
}

// Called only by explicit add/generate actions, never during profile hydration or task recovery.
export async function assertMultimediaGenerationPermission() {
  try {
    const membership = await api.getBillingMembership();
    if (!membership.vipEntitlement?.entitlement.multimediaGenerationEnabled) {
      throw new Error('当前账号未开通多媒体生成权限，请联系管理员或开通相应会员套餐');
    }
  } catch (error) {
    useMultimediaPermissionDialog.setState({ message: error instanceof Error ? error.message : '无法校验多媒体生成权限，请稍后重试' });
    throw error;
  }
}
