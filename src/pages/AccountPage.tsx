import { useEffect, useRef, useState } from 'react';
import { Avatar, Box, Button, Card, CardContent, Alert, TextField, Typography, Dialog, DialogTitle, DialogContent, DialogActions, Switch, FormControlLabel, Chip, CircularProgress, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';
import { useAuthStore } from '../stores/useAuthStore';
import { isImageAvatar as isImageAvatarValue } from '../utils/avatar';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useMessageStore } from '../stores/useMessageStore';
import { ensureCharacterArtifactStoreHydrated, useCharacterArtifactStore } from '../stores/useCharacterArtifactStore';
import { scheduleSyncWorkersByPriority } from '../stores/storeSyncScheduler';
import AppSnackbar from '../components/common/AppSnackbar';
import { DefaultUserAvatarIcon } from '../components/common/IdentityIcons';
import LogoutIcon from '@mui/icons-material/Logout';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';
import { isCloudSyncEnabled, setCloudSyncEnabled } from '../services/cloudSyncPreference';
import { bootstrapLocalDataToCloud, captureLocalCloudBootstrapSnapshot } from '../services/localToCloudBootstrap';
import { runWithCloudSyncBootstrapLock } from '../services/cloudSyncBootstrapLock';
import { api, type BillingMembershipResponse } from '../services/api';
import { getSmsCaptchaToken } from '../services/captcha';
import { formatAiBalanceAmount } from '../utils/aiPoints';
import AiUsageDialog from '../components/account/AiUsageDialog';
import { avatarGenerationQueue } from '../services/avatarGenerationQueue';
import { getPreferredAIProfile, isAIProfileUsable } from '../types/settings';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import UploadIcon from '@mui/icons-material/Upload';

const MAX_AVATAR_FILE_SIZE = 2 * 1024 * 1024;
const MAX_AVATAR_DIMENSION = 512;
const AVATAR_OUTPUT_SIZE = 256;
const AVATAR_OUTPUT_QUALITY = 0.82;
const LEGACY_DEFAULT_USER_AVATAR = '🍵';

function buildAccountAvatarPrompt(requirements: string, language: 'zh' | 'en') {
  const direction = requirements.trim();
  return language === 'zh'
    ? `生成一张个人账号头像。用户要求：${direction || '干净、友好、有辨识度的现代插画头像'}。正方形构图，单一清晰主体居中，主体占画面至少 45%，缩小到 40px 仍清楚可辨；背景简洁、明度对比清楚。不要文字、水印、logo、多人、远景、复杂背景或大面积阴影。`
    : `Generate a personal account avatar. User direction: ${direction || 'a clean, friendly, distinctive modern illustrated avatar'}. Square composition with one clear centered subject filling at least 45% of the frame and recognizable at 40px; simple background with clear value contrast. No text, watermark, logo, multiple people, distant shot, busy background, or large dark shadows.`;
}

function normalizeAccountAvatar(value?: string | null) {
  const trimmed = value?.trim() || '';
  return trimmed === LEGACY_DEFAULT_USER_AVATAR ? '' : trimmed;
}

function formatSyncTime(value?: number, fallback?: string) {
  if (!value) return fallback || '未同步';
  return new Date(value).toLocaleString();
}

function formatAiPoints(balance: Record<string, unknown> | null, loading: boolean, zh: boolean) {
  if (loading) return zh ? 'AI点数：刷新中' : 'AI points: refreshing';
  const raw = balance?.availableBalance ?? balance?.available_balance;
  if (typeof raw === 'number' && Number.isFinite(raw)) return zh ? `AI点数：${formatAiBalanceAmount(balance)}` : `AI points: ${formatAiBalanceAmount(balance)}`;
  return zh ? 'AI点数：未分配点数' : 'AI points: not assigned';
}

function formatMembershipDate(value?: number | string | null) {
  const parsed = Number(value);
  return parsed > 0 ? new Date(parsed).toLocaleDateString() : '-';
}

function formatStorageSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

async function compressAvatar(file: File) {
  const image = await loadImage(file);
  const scale = Math.min(1, MAX_AVATAR_DIMENSION / Math.max(image.width, image.height));
  const sourceWidth = Math.max(1, Math.round(image.width * scale));
  const sourceHeight = Math.max(1, Math.round(image.height * scale));

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = sourceWidth;
  sourceCanvas.height = sourceHeight;
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('无法处理图片');
  sourceContext.drawImage(image, 0, 0, sourceWidth, sourceHeight);

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = AVATAR_OUTPUT_SIZE;
  outputCanvas.height = AVATAR_OUTPUT_SIZE;
  const outputContext = outputCanvas.getContext('2d');
  if (!outputContext) throw new Error('无法处理图片');

  outputContext.fillStyle = '#ffffff';
  outputContext.fillRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);

  const cropSize = Math.min(sourceWidth, sourceHeight);
  const cropX = Math.floor((sourceWidth - cropSize) / 2);
  const cropY = Math.floor((sourceHeight - cropSize) / 2);
  outputContext.drawImage(sourceCanvas, cropX, cropY, cropSize, cropSize, 0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);

  return outputCanvas.toDataURL('image/jpeg', AVATAR_OUTPUT_QUALITY);
}

export default function AccountPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { setHeaderTitle, setHeaderBackAction, setHeaderActions } = useLayoutHeaderActions();
  const { user, authMode, updateProfile, sendChangePhoneCode, changePhone, sendPasswordCode, changePassword, logout } = useAuthStore();
  const retryChatFailedOperations = useChatStore((state) => state.retryFailedOperations);
  const refreshChatSummaryFromCloud = useChatStore((state) => state.refreshChatSummaryFromCloud);
  const markChatsWarm = useChatStore((state) => state.markChatsWarm);
  const prefetchChats = useChatStore((state) => state.prefetchChats);
  const chatLastSyncedAt = useChatStore((state) => state.lastSyncedAt);
  const chatPendingOperationCount = useChatStore((state) => state.pendingOperations.length);
  const retryCharacterFailedOperations = useCharacterStore((state) => state.retryFailedOperations);
  const refreshCharacterSummaryFromCloud = useCharacterStore((state) => state.refreshCharacterSummaryFromCloud);
  const markCharactersWarm = useCharacterStore((state) => state.markCharactersWarm);
  const prefetchCharacters = useCharacterStore((state) => state.prefetchCharacters);
  const characterLastSyncedAt = useCharacterStore((state) => state.lastSyncedAt);
  const characterPendingOperationCount = useCharacterStore((state) => state.pendingOperations.length);
  const loadSettings = useSettingsStore((state) => state.loadSettings);
  const aiProfiles = useSettingsStore((state) => state.aiProfiles);
  const settingsLastSyncedAt = useSettingsStore((state) => state.lastSyncedAt);
  const retryMessageFailedOperations = useMessageStore((state) => state.retryFailedOperations);
  const latestMessageSync = useMessageStore((state) => Object.values(state.messageWindowsByChatId || {}).reduce<number>((latest, item) => (
    Math.max(latest, item.lastSyncedAt || 0)
  ), 0));
  const resumeArtifactProcessing = useCharacterArtifactStore((state) => state.resumeProcessing);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [nickname, setNickname] = useState(user?.nickname || '');
  const [avatar, setAvatar] = useState(() => normalizeAccountAvatar(user?.avatar));
  const [saving, setSaving] = useState(false);
  const [processingAvatar, setProcessingAvatar] = useState(false);
  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false);
  const [generateAvatarDialogOpen, setGenerateAvatarDialogOpen] = useState(false);
  const [avatarRequirements, setAvatarRequirements] = useState('');
  const [nicknameDialogOpen, setNicknameDialogOpen] = useState(false);
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [draftNickname, setDraftNickname] = useState(user?.nickname || '');
  const [savingNickname, setSavingNickname] = useState(false);
  const [sendingPhoneCode, setSendingPhoneCode] = useState(false);
  const [changingPhone, setChangingPhone] = useState(false);
  const [phoneCountdown, setPhoneCountdown] = useState(0);
  const [mockPhoneCode, setMockPhoneCode] = useState('');
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordMode, setPasswordMode] = useState<'old_password' | 'phone_code'>('old_password');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordCode, setPasswordCode] = useState('');
  const [passwordCountdown, setPasswordCountdown] = useState(0);
  const [sendingPasswordCode, setSendingPasswordCode] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });
  const [syncingAll, setSyncingAll] = useState(false);
  const [cloudSyncEnabled, setCloudSyncEnabledState] = useState(isCloudSyncEnabled);
  const [aiBalance, setAiBalance] = useState<Record<string, unknown> | null>(null);
  const [aiBalanceLoading, setAiBalanceLoading] = useState(false);
  const [aiUsageDialogOpen, setAiUsageDialogOpen] = useState(false);
  const [membership, setMembership] = useState<BillingMembershipResponse | null>(null);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const cloudSyncAvailable = authMode !== 'local' && user?.cloudSyncEntitled !== false;

  useEffect(() => {
    setNickname(user?.nickname || '');
    setDraftNickname(user?.nickname || '');
    setAvatar(normalizeAccountAvatar(user?.avatar));
  }, [user]);

  useEffect(() => {
    if (cloudSyncAvailable || !cloudSyncEnabled) return;
    setCloudSyncEnabled(false, { source: 'entitlement' });
    setCloudSyncEnabledState(false);
  }, [cloudSyncAvailable, cloudSyncEnabled]);

  useEffect(() => {
    if (authMode === 'local') {
      setAiBalance(null);
      return;
    }
    let cancelled = false;
    setAiBalanceLoading(true);
    api.getAiBalance('official-2')
      .then((balance) => {
        if (!cancelled) setAiBalance(balance);
      })
      .catch(() => {
        if (!cancelled) setAiBalance(null);
      })
      .finally(() => {
        if (!cancelled) setAiBalanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authMode, user?.id]);

  useEffect(() => {
    if (authMode === 'local') {
      setMembership(null);
      setMembershipLoading(false);
      return;
    }
    let cancelled = false;
    setMembershipLoading(true);
    api.getBillingMembership()
      .then((value) => {
        if (!cancelled) setMembership(value);
      })
      .catch(() => {
        if (!cancelled) setMembership(null);
      })
      .finally(() => {
        if (!cancelled) setMembershipLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authMode, user?.id]);

  useEffect(() => {
    if (phoneCountdown <= 0) return;
    const timer = window.setInterval(() => {
      setPhoneCountdown((value) => value - 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phoneCountdown]);

  useEffect(() => {
    if (passwordCountdown <= 0) return;
    const timer = window.setInterval(() => setPasswordCountdown((value) => value - 1), 1000);
    return () => window.clearInterval(timer);
  }, [passwordCountdown]);

  useEffect(() => {
    setHeaderTitle(t('nav.account'));
    setHeaderBackAction(() => () => navigate(-1));
    setHeaderActions(null);
    return () => {
      setHeaderTitle(null);
      setHeaderBackAction(null);
      setHeaderActions(null);
    };
  }, [navigate, setHeaderActions, setHeaderBackAction, setHeaderTitle, t]);

  const handleUploadAll = async () => {
    if (authMode === 'local') {
      navigate('/login');
      return;
    }
    if (!cloudSyncAvailable) {
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '当前账号暂未开通云同步。' : 'Cloud sync is not available for this account yet.', severity: 'error' });
      return;
    }
    if (!cloudSyncEnabled) {
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '请先开启云同步' : 'Turn on cloud sync first', severity: 'error' });
      return;
    }
    setSyncingAll(true);
    try {
      retryChatFailedOperations();
      retryCharacterFailedOperations();
      retryMessageFailedOperations();
      scheduleSyncWorkersByPriority(0);
      await ensureCharacterArtifactStoreHydrated();
      void resumeArtifactProcessing();
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '已安排后台上传待同步数据' : 'Queued pending uploads in the background', severity: 'success' });
    } catch (error) {
      setSnackbar({ open: true, message: error instanceof Error ? error.message : t('common.error'), severity: 'error' });
    } finally {
      setSyncingAll(false);
    }
  };

  const handleDownloadAll = async () => {
    if (authMode === 'local') {
      navigate('/login');
      return;
    }
    if (!cloudSyncAvailable) {
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '当前账号暂未开通云同步。' : 'Cloud sync is not available for this account yet.', severity: 'error' });
      return;
    }
    if (!cloudSyncEnabled) {
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '请先开启云同步' : 'Turn on cloud sync first', severity: 'error' });
      return;
    }
    setSyncingAll(true);
    try {
      markChatsWarm();
      markCharactersWarm();
      void refreshChatSummaryFromCloud();
      void refreshCharacterSummaryFromCloud();
      void loadSettings();
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '已安排后台拉取云端摘要' : 'Queued cloud summary refresh in the background', severity: 'success' });
    } catch (error) {
      setSnackbar({ open: true, message: error instanceof Error ? error.message : t('common.error'), severity: 'error' });
    } finally {
      setSyncingAll(false);
    }
  };

  const handleLogout = () => {
    void logout();
  };

  const handleAvatarFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_AVATAR_FILE_SIZE) {
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? '头像文件不能超过 2MB' : 'Avatar file must be smaller than 2MB',
        severity: 'error',
      });
      event.target.value = '';
      return;
    }

    if (!file.type.startsWith('image/')) {
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? '请上传图片文件' : 'Please upload an image file',
        severity: 'error',
      });
      event.target.value = '';
      return;
    }

    setProcessingAvatar(true);
    try {
      const compressed = await compressAvatar(file);
      setAvatar(compressed);
      await handleSaveAvatar(compressed);
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : t('common.error'),
        severity: 'error',
      });
    } finally {
      setProcessingAvatar(false);
      event.target.value = '';
    }
  };

  const handleSaveAvatar = async (nextAvatar: string) => {
    setSaving(true);
    try {
      await updateProfile({ avatar: normalizeAccountAvatar(nextAvatar) });
      setSnackbar({ open: true, message: t('common.success'), severity: 'success' });
    } catch (error) {
      setSnackbar({ open: true, message: error instanceof Error ? error.message : t('common.error'), severity: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateAvatar = () => {
    const imageProfile = getPreferredAIProfile(aiProfiles, 'image');
    if (!isAIProfileUsable(imageProfile)) {
      setSnackbar({ open: true, message: zh ? '请先在 AI 模型中配置可用的图片模型' : 'Configure an available image model in AI Models first', severity: 'error' });
      return;
    }
    avatarGenerationQueue.enqueue(imageProfile, buildAccountAvatarPrompt(avatarRequirements, zh ? 'zh' : 'en'), {
      targetKey: `account-avatar:${user?.id || 'local'}`,
      accountAvatar: true,
      description: zh ? '账号头像' : 'Account avatar',
      negativePrompt: zh ? '文字、水印、logo、多人、远景、复杂背景、大面积阴影' : 'text, watermark, logo, multiple people, distant shot, busy background, large dark shadows',
    });
    setGenerateAvatarDialogOpen(false);
    setAvatarRequirements('');
    setSnackbar({ open: true, message: zh ? '已加入头像生成队列' : 'Avatar generation queued', severity: 'success' });
  };

  const handleSaveNickname = async () => {
    setSavingNickname(true);
    try {
      await updateProfile({ nickname: draftNickname.trim() });
      setNicknameDialogOpen(false);
      setSnackbar({ open: true, message: t('common.success'), severity: 'success' });
    } catch (error) {
      setSnackbar({ open: true, message: error instanceof Error ? error.message : t('common.error'), severity: 'error' });
    } finally {
      setSavingNickname(false);
    }
  };

  const openPhoneDialog = () => {
    if (authMode === 'local' || !user) return;
    setNewPhone(user?.phone || '');
    setPhoneCode('');
    setMockPhoneCode('');
    setPhoneCountdown(0);
    setPhoneDialogOpen(true);
  };

  const openNicknameDialog = () => {
    setDraftNickname(user?.nickname || '');
    setNicknameDialogOpen(true);
  };

  const openPasswordDialog = () => {
    setPasswordMode('old_password'); setOldPassword(''); setNewPassword(''); setPasswordCode(''); setPasswordCountdown(0); setPasswordDialogOpen(true);
  };

  const handleSendPasswordCode = async () => {
    setSendingPasswordCode(true);
    try {
      const result = await sendPasswordCode(await getSmsCaptchaToken({ phone: user?.phone || '', purpose: 'forgot-password' }));
      setPasswordCountdown(60);
      if (result.mock && result.code) setPasswordCode(result.code);
      setSnackbar({ open: true, message: zh ? '验证码已发送' : 'Verification code sent', severity: 'success' });
    } catch (error) { setSnackbar({ open: true, message: error instanceof Error ? error.message : t('common.error'), severity: 'error' }); }
    finally { setSendingPasswordCode(false); }
  };

  const handleChangePassword = async () => {
    if (newPassword.length < 8) { setSnackbar({ open: true, message: zh ? '新密码至少需要8位' : 'Password must be at least 8 characters', severity: 'error' }); return; }
    setChangingPassword(true);
    try {
      await changePassword({ mode: passwordMode, oldPassword: passwordMode === 'old_password' ? oldPassword : undefined, code: passwordMode === 'phone_code' ? passwordCode : undefined, newPassword });
      setPasswordDialogOpen(false); setSnackbar({ open: true, message: zh ? '密码修改成功' : 'Password updated', severity: 'success' });
    } catch (error) { setSnackbar({ open: true, message: error instanceof Error ? error.message : t('common.error'), severity: 'error' }); }
    finally { setChangingPassword(false); }
  };

  const openAvatarDialog = () => {
    setAvatarDialogOpen(true);
  };

  const handleSelectAvatarFile = () => {
    setAvatarDialogOpen(false);
    fileInputRef.current?.click();
  };

  const rowSx = {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    p: 2,
    borderRadius: 2,
    border: 1,
    borderColor: 'divider',
    cursor: 'pointer',
    transition: 'all 0.18s ease',
    '&:hover': { borderColor: 'primary.main', boxShadow: 1 },
  } as const;

  const compactRowSx = {
    display: 'flex',
    alignItems: 'center',
    gap: 1.5,
    minWidth: 0,
    cursor: 'pointer',
    borderRadius: 2,
    transition: 'background-color 0.18s ease, box-shadow 0.18s ease',
    '&:hover': {
      backgroundColor: 'action.hover',
      boxShadow: 1,
    },
  } as const;

  const handleSendPhoneCode = async () => {
    if (!newPhone || newPhone.length < 5) {
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '请输入有效的手机号' : 'Please enter a valid phone number', severity: 'error' });
      return;
    }

    if (newPhone === user?.phone) {
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '新手机号不能与当前手机号相同' : 'New phone number must be different', severity: 'error' });
      return;
    }

    setSendingPhoneCode(true);
    try {
      const captchaToken = await getSmsCaptchaToken({ phone: newPhone, purpose: 'change-phone' });
      const result = await sendChangePhoneCode(newPhone, captchaToken);
      setPhoneCountdown(60);
      if (result.mock && result.code) {
        setMockPhoneCode(result.code);
        setPhoneCode(result.code);
      } else {
        setMockPhoneCode('');
      }
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '验证码已发送' : 'Verification code sent', severity: 'success' });
    } catch (error) {
      setSnackbar({ open: true, message: error instanceof Error ? error.message : t('common.error'), severity: 'error' });
    } finally {
      setSendingPhoneCode(false);
    }
  };

  const handleChangePhone = async () => {
    if (!newPhone || !phoneCode) {
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '请输入手机号和验证码' : 'Please enter phone number and code', severity: 'error' });
      return;
    }

    setChangingPhone(true);
    try {
      await changePhone(newPhone, phoneCode);
      setNewPhone('');
      setPhoneCode('');
      setMockPhoneCode('');
      setPhoneCountdown(0);
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '手机号修改成功' : 'Phone number updated', severity: 'success' });
    } catch (error) {
      setSnackbar({ open: true, message: error instanceof Error ? error.message : t('common.error'), severity: 'error' });
    } finally {
      setChangingPhone(false);
    }
  };

  const isImageAvatar = isImageAvatarValue(avatar);
  const zh = i18n.language.startsWith('zh');
  const phoneLabel = zh ? '手机号' : 'Phone';
  const phoneEditable = authMode !== 'local' && Boolean(user);
  const activeMembership = Boolean(membership?.vipActive && membership.activeSubscription);
  const visibleSubscription = membership?.activeSubscription || membership?.latestSubscription || null;
  const membershipStatusLabel = activeMembership
    ? (zh ? '会员生效中' : 'Active')
    : visibleSubscription
      ? (zh ? '会员已到期' : 'Expired')
      : (zh ? '未开通会员' : 'No membership');
  const membershipStatusColor: 'success' | 'warning' | 'default' = activeMembership ? 'success' : visibleSubscription ? 'warning' : 'default';
  const membershipEntitlement = membership?.vipEntitlement?.entitlement;
  const membershipUsage = membership?.usage;
  const quotaValue = (used: number, limit: number | null | undefined) => (
    limit === -1 ? `${used} / -` : `${used} / ${limit ?? '-'}`
  );
  const membershipUsageRows = membershipEntitlement && membershipUsage ? [
    { label: zh ? '角色数量' : 'Characters', value: quotaValue(membershipUsage.characters, membershipEntitlement.maxCharacters) },
    { label: zh ? '聊天数量' : 'Chats', value: quotaValue(membershipUsage.chats, membershipEntitlement.maxChats) },
    { label: zh ? '群成员上限' : 'Group member limit', value: membershipEntitlement.maxGroupMembers == null || membershipEntitlement.maxGroupMembers === -1 ? '-' : `${membershipEntitlement.maxGroupMembers}` },
    { label: zh ? '今日 AI 生成' : 'AI generations today', value: quotaValue(membership?.dailyAiGenerationUsage?.used || 0, membershipEntitlement.dailyAiGenerationLimit) },
    { label: zh ? '单次批量生成' : 'Batch generation per run', value: membershipEntitlement.batchGenerationLimit == null
      ? '-'
      : membershipEntitlement.batchGenerationLimit === -1
        ? '-'
      : `${membershipEntitlement.batchGenerationLimit}` },
    { label: zh ? '云空间' : 'Cloud storage', value: membershipEntitlement.cloudStorageBytes !== -1
      ? `${formatStorageSize(membershipUsage.cloudStorageBytes)} / ${formatStorageSize(membershipEntitlement.cloudStorageBytes)}`
      : `${formatStorageSize(membershipUsage.cloudStorageBytes)} / -` },
  ] : [];
  const handleCloudSyncToggle = async (enabled: boolean) => {
    if (authMode === 'local') {
      navigate('/login');
      return;
    }
    if (!cloudSyncAvailable) {
      setCloudSyncEnabled(false, { source: 'entitlement' });
      setCloudSyncEnabledState(false);
      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '当前账号暂未开通云同步。' : 'Cloud sync is not available for this account yet.', severity: 'error' });
      return;
    }
    const previousEnabled = cloudSyncEnabled;
    setCloudSyncEnabled(enabled);
    setCloudSyncEnabledState(enabled);
    if (!enabled) {
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? '已关闭云同步。后续数据只保存在本设备。' : 'Cloud sync is off. Future data stays on this device.',
        severity: 'success',
      });
      return;
    }

    setSyncingAll(true);
    try {
      const snapshot = await captureLocalCloudBootstrapSnapshot();
      await runWithCloudSyncBootstrapLock(() => bootstrapLocalDataToCloud(snapshot));
      markChatsWarm();
      markCharactersWarm();
      void prefetchChats();
      void prefetchCharacters();
      void loadSettings();
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? '已开启云同步，并完成本地与云端数据准备。' : 'Cloud sync is on. Local and cloud data are prepared.',
        severity: 'success',
      });
    } catch (error) {
      setCloudSyncEnabled(previousEnabled);
      setCloudSyncEnabledState(previousEnabled);
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : t('common.error'),
        severity: 'error',
      });
    } finally {
      setSyncingAll(false);
    }
  };

  return (
    <Box sx={{ p: 3, pt: { xs: 1, sm: 1, md: 3 }, pb: { xs: 12, sm: 8 }, maxWidth: 980, mx: 'auto' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1.15fr) minmax(280px, 0.85fr)' }, gap: 3, alignItems: 'stretch' }}>
        <Card
          variant="outlined"
          sx={{
            overflow: 'hidden',
            borderRadius: 2,
            height: '100%',
            bgcolor: (theme) => theme.palette.mode === 'dark' ? 'rgba(18,18,18,0.96)' : 'rgba(255,255,255,0.92)',
          }}
        >
          <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box sx={{ pt: 1, pb: 0.5 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {i18n.language.startsWith('zh') ? '账号信息' : 'Account info'}
              </Typography>
              {authMode === 'local' ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                  {i18n.language.startsWith('zh') ? '当前处于离线本地模式。所有数据仅保存在当前设备，登录后会自动尝试同步。' : 'You are in local-only mode. Data is stored on this device and will be uploaded automatically after sign-in.'}
                </Typography>
              ) : null}
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              <Box sx={{ ...rowSx, gap: 2, justifyContent: 'flex-start' }} onClick={openNicknameDialog}>
                <Box
                  sx={compactRowSx}
                  onClick={(event) => {
                    event.stopPropagation();
                    openAvatarDialog();
                  }}
                >
                  <Avatar src={isImageAvatar ? avatar : undefined} sx={{ width: 52, height: 52, fontSize: '1.5rem', bgcolor: 'transparent' }}>
                    {isImageAvatar ? undefined : avatar || <DefaultUserAvatarIcon title={nickname || 'User'} />}
                  </Avatar>
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body1" sx={{ minWidth: 0, fontWeight: 600 }} noWrap>
                    {authMode === 'local' ? (i18n.language.startsWith('zh') ? '本地用户' : 'Local user') : (user?.nickname || '-')}
                  </Typography>
                </Box>
              </Box>

              <Box
                sx={{
                  ...rowSx,
                  ...(phoneEditable
                    ? {}
                    : {
                      cursor: 'default',
                      opacity: 0.72,
                      '&:hover': { borderColor: 'divider', boxShadow: 'none' },
                    }),
                }}
                onClick={phoneEditable ? openPhoneDialog : undefined}
                aria-disabled={!phoneEditable}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    {phoneLabel}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    {authMode === 'local' ? (i18n.language.startsWith('zh') ? '未登录' : 'Not signed in') : (user?.phone || '-')}
                  </Typography>
                </Box>
                {phoneEditable ? <Button size="small" variant="text" onClick={(event) => { event.stopPropagation(); openPhoneDialog(); }}>{zh ? '修改' : 'Change'}</Button> : null}
              </Box>
            </Box>

            <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleAvatarFileChange} />

            {authMode === 'local' ? (
              <Button variant="contained" onClick={() => navigate('/login')} sx={{ alignSelf: 'flex-start' }}>
                {i18n.language.startsWith('zh') ? '登录并同步' : 'Sign in & sync'}
              </Button>
            ) : (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Button variant="outlined" onClick={openPasswordDialog}>
                  {zh ? '修改密码' : 'Change password'}
                </Button>
                <Button variant="outlined" color="error" startIcon={<LogoutIcon />} onClick={handleLogout}>
                  {i18n.language.startsWith('zh') ? '退出登录' : 'Log out'}
                </Button>
              </Box>
            )}
          </CardContent>
        </Card>

        <Card
          variant="outlined"
          sx={{
            overflow: 'hidden',
            borderRadius: 2,
            height: '100%',
            bgcolor: (theme) => theme.palette.mode === 'dark' ? 'rgba(18,18,18,0.96)' : 'rgba(255,255,255,0.92)',
          }}
        >
          <CardContent sx={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ width: 36, height: 36, borderRadius: 1.25, display: 'grid', placeItems: 'center', bgcolor: 'primary.main', color: 'primary.contrastText' }}>
                  <WorkspacePremiumIcon fontSize="small" />
                </Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
                  {zh ? '会员权益' : 'Membership'}
                </Typography>
              </Box>
              {membershipLoading ? (
                <CircularProgress size={18} />
              ) : (
                <Chip size="small" color={membershipStatusColor} label={authMode === 'local' ? (zh ? '未登录' : 'Local') : membershipStatusLabel} />
              )}
            </Box>

            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1.15, py: 0.5 }}>
              <Box>
                <Typography variant="body2" color="text.secondary">
                  {zh ? '当前套餐' : 'Current plan'}
                </Typography>
                <Typography sx={{ mt: 0.25, fontSize: 20, fontWeight: 900 }} noWrap>
                  {authMode === 'local'
                    ? (zh ? '登录后查看' : 'Sign in to view')
                    : (visibleSubscription?.planName || membershipStatusLabel)}
                </Typography>
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.25 }}>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    {zh ? '状态' : 'Status'}
                  </Typography>
                  <Typography sx={{ fontWeight: 800 }}>
                    {authMode === 'local' ? (zh ? '未登录' : 'Local') : membershipStatusLabel}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    {zh ? '有效期至' : 'Valid until'}
                  </Typography>
                  <Typography sx={{ fontWeight: 800 }}>
                    {activeMembership ? formatMembershipDate(visibleSubscription?.currentPeriodEnd) : '-'}
                  </Typography>
                </Box>
              </Box>
              {membershipUsageRows.length ? (
                <Table size="small" aria-label={zh ? '会员权益用量' : 'Membership usage'} sx={{ mt: 0.15, tableLayout: 'fixed' }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ width: '48%', px: 0, py: 0.35, color: 'text.secondary', fontSize: 12, borderBottomColor: 'divider' }}>
                        {zh ? '项目' : 'Item'}
                      </TableCell>
                      <TableCell align="right" sx={{ px: 0, py: 0.35, color: 'text.secondary', fontSize: 12, borderBottomColor: 'divider' }}>
                        {zh ? '数量' : 'Amount'}
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {membershipUsageRows.map((item) => (
                      <TableRow key={item.label}>
                        <TableCell sx={{ px: 0, py: 0.45, fontSize: 12, borderBottomColor: 'divider' }}>{item.label}</TableCell>
                        <TableCell align="right" sx={{ px: 0, py: 0.45, fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap', borderBottomColor: 'divider' }}>{item.value}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : null}
            </Box>

            <Button
              variant={activeMembership ? 'outlined' : 'contained'}
              onClick={() => navigate('/membership')}
              sx={{ alignSelf: 'flex-start' }}
            >
              {activeMembership ? (zh ? '查看会员' : 'View membership') : (zh ? '开通会员' : 'Subscribe')}
            </Button>
          </CardContent>
        </Card>
        </Box>

        <Card variant="outlined">
          <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {i18n.language.startsWith('zh') ? 'AI点数' : 'AI points'}
              </Typography>
              <Button
                variant="outlined"
                size="small"
                disabled={authMode === 'local'}
                onClick={() => setAiUsageDialogOpen(true)}
              >
                {i18n.language.startsWith('zh') ? '查看消耗' : 'Usage'}
              </Button>
            </Box>
            <Typography variant="body2" color="text.secondary">
              {authMode === 'local'
                ? (i18n.language.startsWith('zh') ? '登录后查看点数' : 'Sign in to view points')
                : formatAiPoints(aiBalance, aiBalanceLoading, i18n.language.startsWith('zh'))}
            </Typography>
          </CardContent>
        </Card>

        <AiUsageDialog open={aiUsageDialogOpen} onClose={() => setAiUsageDialogOpen(false)} />

        <Card variant="outlined">
          <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                {i18n.language.startsWith('zh') ? '云同步情况' : 'Cloud sync status'}
              </Typography>
              <Button variant="outlined" size="small" onClick={() => navigate('/account/sync-status')}>
                {i18n.language.startsWith('zh') ? '查看详情' : 'Details'}
              </Button>
            </Box>
            <FormControlLabel
              control={
                <Switch
                  checked={authMode !== 'local' && cloudSyncEnabled}
                  disabled={authMode === 'local' || !cloudSyncAvailable || syncingAll}
                  onChange={(event) => handleCloudSyncToggle(event.target.checked)}
                />
              }
              label={i18n.language.startsWith('zh') ? '开启云同步' : 'Enable cloud sync'}
            />
            <Typography variant="body2" color="text.secondary">
              {authMode === 'local'
                ? (i18n.language.startsWith('zh') ? '登录后才可使用云同步。' : 'Sign in to use cloud sync.')
                : !cloudSyncAvailable
                  ? (i18n.language.startsWith('zh') ? '当前账号暂未开通云同步；本地数据仍可正常使用。' : 'Cloud sync is not available for this account yet; local data remains usable.')
                : cloudSyncEnabled
                  ? (i18n.language.startsWith('zh') ? '当前设备会按需上传和拉取云端数据。' : 'This device uploads and downloads cloud data as needed.')
                  : (i18n.language.startsWith('zh') ? '云同步已关闭，当前设备只读写本地缓存，不会自动访问云端数据接口。' : 'Cloud sync is off. This device uses local cache only and will not automatically call cloud data APIs.')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {i18n.language.startsWith('zh') ? '设置同步' : 'Settings sync'}：{formatSyncTime(settingsLastSyncedAt, i18n.language.startsWith('zh') ? '未同步' : 'Not synced')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {i18n.language.startsWith('zh') ? '群聊同步' : 'Chats sync'}：{formatSyncTime(chatLastSyncedAt, i18n.language.startsWith('zh') ? '未同步' : 'Not synced')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {i18n.language.startsWith('zh') ? '角色同步' : 'Characters sync'}：{formatSyncTime(characterLastSyncedAt, i18n.language.startsWith('zh') ? '未同步' : 'Not synced')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {i18n.language.startsWith('zh') ? '消息缓存刷新' : 'Message cache refresh'}：{formatSyncTime(latestMessageSync, i18n.language.startsWith('zh') ? '未同步' : 'Not synced')}
            </Typography>
            {characterPendingOperationCount + chatPendingOperationCount > 0 ? (
              <Typography variant="body2" color="text.secondary">
                {i18n.language.startsWith('zh') ? '待同步编辑操作' : 'Queued edit sync operations'}：{characterPendingOperationCount + chatPendingOperationCount}
              </Typography>
            ) : null}
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Button variant="outlined" onClick={handleUploadAll} disabled={syncingAll || (authMode !== 'local' && (!cloudSyncAvailable || !cloudSyncEnabled))}>
                {syncingAll ? (i18n.language.startsWith('zh') ? '同步中' : 'Syncing') : (i18n.language.startsWith('zh') ? '同步待上传' : 'Sync pending uploads')}
              </Button>
              <Button variant="outlined" onClick={handleDownloadAll} disabled={syncingAll || (authMode !== 'local' && (!cloudSyncAvailable || !cloudSyncEnabled))}>
                {syncingAll ? (i18n.language.startsWith('zh') ? '同步中' : 'Syncing') : (i18n.language.startsWith('zh') ? '检查云端更新' : 'Check cloud updates')}
              </Button>
            </Box>
          </CardContent>
        </Card>
      </Box>

      <Dialog open={nicknameDialogOpen} onClose={() => setNicknameDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{i18n.language.startsWith('zh') ? '修改昵称' : 'Change nickname'}</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 1 }}>
            <TextField
              label={i18n.language.startsWith('zh') ? '昵称' : 'Nickname'}
              value={draftNickname}
              onChange={(e) => setDraftNickname(e.target.value)}
              fullWidth
            />
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setNicknameDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={handleSaveNickname} disabled={savingNickname || !draftNickname.trim()}>
            {savingNickname ? t('common.loading') : t('common.save')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={phoneDialogOpen} onClose={() => setPhoneDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{i18n.language.startsWith('zh') ? '修改手机号' : 'Change phone number'}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <TextField
              label={phoneLabel}
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              fullWidth
            />
            {mockPhoneCode ? (
              <Alert severity="info">
                {i18n.language.startsWith('zh') ? `开发模式 - 验证码：${mockPhoneCode}` : `Development mode - code: ${mockPhoneCode}`}
              </Alert>
            ) : null}
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                label={i18n.language.startsWith('zh') ? '验证码' : 'Verification code'}
                value={phoneCode}
                onChange={(e) => setPhoneCode(e.target.value)}
                fullWidth
              />
              <Button variant="outlined" onClick={handleSendPhoneCode} disabled={sendingPhoneCode || phoneCountdown > 0} sx={{ minWidth: 120 }}>
                {phoneCountdown > 0 ? `${phoneCountdown}s` : (sendingPhoneCode ? t('common.loading') : (i18n.language.startsWith('zh') ? '发送验证码' : 'Send code'))}
              </Button>
            </Box>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setPhoneDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={handleChangePhone} disabled={changingPhone || !newPhone || !phoneCode}>
            {changingPhone ? t('common.loading') : t('common.confirm')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={passwordDialogOpen} onClose={() => setPasswordDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{zh ? '修改密码' : 'Change password'}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button variant={passwordMode === 'old_password' ? 'contained' : 'outlined'} onClick={() => setPasswordMode('old_password')} fullWidth>{zh ? '旧密码' : 'Old password'}</Button>
              <Button variant={passwordMode === 'phone_code' ? 'contained' : 'outlined'} onClick={() => setPasswordMode('phone_code')} fullWidth>{zh ? '手机号验证' : 'Phone code'}</Button>
            </Box>
            {passwordMode === 'old_password' ? (
              <TextField label={zh ? '旧密码' : 'Old password'} type="password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} fullWidth />
            ) : (
              <Box sx={{ display: 'flex', gap: 1 }}>
                <TextField label={zh ? '验证码' : 'Verification code'} value={passwordCode} onChange={(event) => setPasswordCode(event.target.value)} fullWidth />
                <Button variant="outlined" onClick={handleSendPasswordCode} disabled={sendingPasswordCode || passwordCountdown > 0} sx={{ minWidth: 120 }}>{passwordCountdown > 0 ? `${passwordCountdown}s` : (sendingPasswordCode ? t('common.loading') : (zh ? '发送验证码' : 'Send code'))}</Button>
              </Box>
            )}
            <TextField label={zh ? '新密码' : 'New password'} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} helperText={zh ? '至少 8 位' : 'At least 8 characters'} fullWidth />
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setPasswordDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={handleChangePassword} disabled={changingPassword || !newPassword || (passwordMode === 'old_password' ? !oldPassword : !passwordCode)}>{changingPassword ? t('common.loading') : t('common.confirm')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={avatarDialogOpen} onClose={() => setAvatarDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{i18n.language.startsWith('zh') ? '头像预览' : 'Avatar preview'}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
            <Avatar src={isImageAvatar ? avatar : undefined} sx={{ width: 220, height: 220, fontSize: '5rem', bgcolor: 'transparent' }}>
              {isImageAvatar ? undefined : avatar || <DefaultUserAvatarIcon title={nickname || 'User'} />}
            </Avatar>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setAvatarDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button
            variant="outlined"
            startIcon={<AutoAwesomeIcon />}
            onClick={() => setGenerateAvatarDialogOpen(true)}
            disabled={processingAvatar || saving}
          >
            {zh ? '生成' : 'Generate'}
          </Button>
          <Button
            variant="contained"
            startIcon={<UploadIcon />}
            onClick={handleSelectAvatarFile}
            disabled={processingAvatar || saving}
          >
            {processingAvatar ? t('common.loading') : (zh ? '上传' : 'Upload')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={generateAvatarDialogOpen} onClose={() => setGenerateAvatarDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{zh ? '生成头像' : 'Generate avatar'}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            multiline
            minRows={4}
            fullWidth
            label={zh ? '头像要求' : 'Avatar direction'}
            placeholder={zh ? '例如：低饱和水彩插画，戴圆框眼镜，安静但有一点幽默感' : 'For example: muted watercolor illustration, round glasses, quiet with a hint of humor'}
            value={avatarRequirements}
            onChange={(event) => setAvatarRequirements(event.target.value)}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setGenerateAvatarDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" startIcon={<AutoAwesomeIcon />} onClick={handleGenerateAvatar}>{zh ? '生成' : 'Generate'}</Button>
        </DialogActions>
      </Dialog>

      <AppSnackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
        severity={snackbar.severity}
        message={snackbar.message}
      />
    </Box>
  );
}
