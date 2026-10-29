import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Alert, Avatar, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import FloatingSegmentedTabs from '../components/common/FloatingSegmentedTabs';
import { buildFloatingTabContainerSx } from '../components/common/FloatingSegmentedTabs.styles';
import AccessState, { accessStateActions } from '../components/common/AccessState';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';
import SurfaceCard from '../components/common/SurfaceCard';
import { buildBundledCharacterPreview, buildImportedChatDraft, getBundledCharacterEntries, remapIds } from '../services/marketImportDraft';
import { marketApi, type MarketItem, type MarketItemKind } from '../services/marketApi';
import { useAuthStore } from '../stores/useAuthStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useChatStore } from '../stores/useChatStore';
import type { AICharacter } from '../types/character';
import { normalizeConversation, type ChatStyle, type ConversationMode, type ConversationType, type GroupChat, type RuntimeEvolutionIntensity } from '../types/chat';

const kindLabels: Record<MarketItemKind, string> = {
  character_template: '角色模板',
  chat_template: '聊天模板',
  bundle_template: '组合包',
};

const kindFilterOptions: Array<{ value: MarketItemKind | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'bundle_template', label: '组合包' },
  { value: 'character_template', label: '角色' },
  { value: 'chat_template', label: '聊天' },
];

const chatTypeLabels: Record<string, string> = {
  group: '普通群聊',
  direct: '私聊',
  ai_direct: '角色私聊',
};

const chatModeLabels: Record<string, string> = {
  open_chat: '开放聊天',
  story: '故事房',
  story_reader: '故事房',
  group_discussion: '群聊讨论',
  roundtable: '圆桌',
  werewolf: '狼人杀',
  murder_mystery: '剧本推理',
};

const scenarioLabels: Record<string, string> = {
  'open-chat': '普通群聊',
  'direct-chat': '私聊',
  'ai-private-thread': '角色私聊',
  'story-reader': '故事房',
  'opinion-review': '观点讨论',
  'roundtable-review': '圆桌讨论',
  'role-debate': '角色辩论',
  'courtroom-deliberation': '法庭审议',
  'expert-review': '专家评审',
  'public-inquiry': '公开质询',
  'brainstorm-workshop': '头脑风暴',
  'task-retrospective': '任务复盘',
  'werewolf-classic': '狼人杀',
  'murder-mystery': '剧本推理',
  'board-game': '棋盘游戏',
};

const personalityLabels: Record<string, string> = {
  openness: '开放',
  extroversion: '外向',
  agreeableness: '亲和',
  neuroticism: '敏感',
  humor: '幽默',
  creativity: '创造',
  assertiveness: '主见',
  empathy: '共情',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compactText(value: unknown, max = 240) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function getLocalizedLabel(value: unknown, labels: Record<string, string>) {
  const key = compactText(value, 120);
  return key ? labels[key] || '' : '';
}

function getScenarioLabel(value: unknown) {
  const sessionKind = asRecord(value);
  return getLocalizedLabel(sessionKind.scenarioId, scenarioLabels)
    || getLocalizedLabel(sessionKind.family, {
      conversation: '聊天',
      analysis: '讨论',
      study: '学习',
      deduction: '推理',
      mystery: '推理',
      board_game: '棋盘',
      agent: '协作',
      simulation: '模拟',
    });
}

function isImageValue(value: unknown) {
  const text = compactText(value, 5000);
  return text.startsWith('data:image/') || /^https?:\/\//i.test(text);
}

function getCharacterFromItem(item: MarketItem | null) {
  return asRecord(item?.payload?.character);
}

function getPreviewPayload(item: MarketItem | null) {
  return asRecord(item?.previewPayload || item?.payload);
}

function getPreviewCharacter(item: MarketItem | null) {
  return asRecord(getPreviewPayload(item).character);
}

function getPreviewChat(item: MarketItem | null) {
  return asRecord(getPreviewPayload(item).chat);
}

function getPreviewCharacters(item: MarketItem | null) {
  return asArray(getPreviewPayload(item).characters).map(asRecord);
}

function normalizeMarketCharacterPreview(entry: Record<string, unknown>, index: number) {
  const template = asRecord(entry.template);
  const name = compactText(entry.name || template.name, 80);
  const avatar = compactText(entry.avatar || template.avatar, 5000);
  const localId = compactText(entry.localId || entry.id || template.id || name || `character-${index}`, 120);
  return {
    ...entry,
    localId,
    name,
    avatar,
  };
}

function getMarketCharacterPreviews(item: MarketItem | null) {
  const previewCharacters = getPreviewCharacters(item);
  const source = previewCharacters.length
    ? previewCharacters
    : asArray(item?.payload?.characters).map(asRecord);
  return source
    .map(normalizeMarketCharacterPreview)
    .filter((entry) => entry.name || entry.avatar || entry.localId);
}

function getCharacterReferenceImages(character: Record<string, unknown>) {
  const visualIdentity = asRecord(character.visualIdentity);
  return [...asArray(visualIdentity.referenceImages), ...asArray(character.visualReferenceImages)]
    .map(asRecord)
    .filter((image) => isImageValue(image.url));
}

function getCardImage(item: MarketItem) {
  if (isImageValue(item.coverImage)) return item.coverImage || '';
  const previewCharacter = getPreviewCharacter(item);
  if (isImageValue(previewCharacter.coverImage)) return compactText(previewCharacter.coverImage, 5000);
  const character = getCharacterFromItem(item);
  return compactText(getCharacterReferenceImages(character)[0]?.url, 5000);
}

function getAvatarValue(item: MarketItem) {
  const previewCharacter = getPreviewCharacter(item);
  if (compactText(previewCharacter.avatar, 5000)) return compactText(previewCharacter.avatar, 5000);
  const character = getCharacterFromItem(item);
  return compactText(character.avatar, 5000) || (isImageValue(item.coverImage) ? item.coverImage || '' : '');
}

function getCardDescription(item: MarketItem) {
  const preview = getPreviewPayload(item);
  if (item.kind === 'character_template') {
    const character = asRecord(preview.character);
    return compactText(character.visualDescription || character.coreDesire || character.speakingStyle || character.background || item.summary, 180);
  }
  const chat = asRecord(preview.chat);
  return compactText(chat.topic || item.summary, 180);
}

function getChatTitle(item: MarketItem) {
  const chat = getPreviewChat(item);
  return compactText(chat.name || chat.topic || item.title, 80) || item.title;
}

function renderTextBlock(label: string, value: unknown, max?: number) {
  const text = compactText(value, max);
  if (!text) return null;
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</Typography>
    </Box>
  );
}

function DetailPanel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <SurfaceCard contentSx={{ p: 1.5, display: 'grid', gap: 1, alignContent: 'start', '&:last-child': { pb: 1.5 } }}>
      {title ? <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800 }}>{title}</Typography> : null}
      {children}
    </SurfaceCard>
  );
}

function MetricChip({ label, value }: { label: string; value: unknown }) {
  const numericValue = Number(value || 0);
  if (!numericValue) return null;
  return <Chip size="small" variant="outlined" label={`${label} ${numericValue}`} />;
}

function MarketItemDetail({ item }: { item: MarketItem }) {
  if (item.kind === 'character_template') {
    const character = getCharacterFromItem(item);
    const visualIdentity = asRecord(character.visualIdentity);
    const coreProfile = asRecord(character.coreProfile);
    const personality = asRecord(character.personality);
    const images = getCharacterReferenceImages(character);
    const avatar = getAvatarValue(item);
    const expertise = asArray(character.expertise).map(String).filter(Boolean);
    const primaryImage = images.find((image) => image.isPrimary) || images[0];
    return (
      <Stack spacing={1.5}>
        <SurfaceCard
          contentSx={{
            p: 1.5,
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: primaryImage ? '180px minmax(0, 1fr)' : '1fr' },
            gap: 1.5,
            alignItems: 'stretch',
            '&:last-child': { pb: 1.5 },
          }}
        >
          {primaryImage ? (
            <Box
              component="img"
              src={compactText(primaryImage.url, 5000)}
              alt={String(primaryImage.label || item.title)}
              sx={{ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: 1, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}
            />
          ) : null}
          <Stack spacing={1.25} sx={{ justifyContent: 'space-between', minWidth: 0 }}>
            <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', minWidth: 0 }}>
              <Avatar src={isImageValue(avatar) ? avatar : undefined} sx={{ width: 56, height: 56, fontSize: 24 }}>
                {isImageValue(avatar) ? undefined : avatar.slice(0, 2) || item.title.slice(0, 1)}
              </Avatar>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="h6" sx={{ fontWeight: 900, lineHeight: 1.2 }} noWrap>{item.title}</Typography>
                <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: 'wrap', gap: 0.75 }}>
                  <Chip size="small" label={kindLabels[item.kind]} />
                  {expertise.slice(0, 4).map((entry) => <Chip key={entry} size="small" variant="outlined" label={entry} />)}
                </Stack>
              </Box>
            </Stack>
            {renderTextBlock('核心画像', coreProfile.coreDesire || character.background || item.summary, 420)}
          </Stack>
        </SurfaceCard>
        {images.length > 1 ? (
          <Stack direction="row" spacing={1} sx={{ overflowX: 'auto', pb: 0.5 }}>
            {images.slice(0, 8).map((image, index) => (
              <Box
                key={String(image.id || image.assetId || index)}
                component="img"
                src={compactText(image.url, 5000)}
                alt={String(image.label || '形象图')}
                sx={{ width: 80, height: 104, objectFit: 'cover', borderRadius: 1, border: '1px solid', borderColor: image.isPrimary ? 'primary.main' : 'divider', flex: '0 0 auto' }}
              />
            ))}
          </Stack>
        ) : null}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.25 }}>
          {(compactText(visualIdentity.description) || compactText(visualIdentity.styleHint)) ? (
            <DetailPanel title="形象">
              {renderTextBlock('视觉形象', visualIdentity.description, 420)}
              {renderTextBlock('风格提示', visualIdentity.styleHint, 260)}
            </DetailPanel>
          ) : null}
          {(compactText(coreProfile.coreDesire) || compactText(coreProfile.coreFear) || compactText(coreProfile.socialMask)) ? (
            <DetailPanel title="内核">
              {renderTextBlock('核心欲望', coreProfile.coreDesire, 220)}
              {renderTextBlock('核心恐惧', coreProfile.coreFear, 220)}
              {renderTextBlock('社交面具', coreProfile.socialMask, 220)}
            </DetailPanel>
          ) : null}
          {(compactText(character.speakingStyle) || compactText(character.background || item.summary)) ? (
            <DetailPanel title="表达">
              {renderTextBlock('说话风格', character.speakingStyle, 280)}
              {renderTextBlock('背景', character.background || item.summary, 420)}
            </DetailPanel>
          ) : null}
          {Object.keys(personality).length ? (
            <DetailPanel title="人格参数">
              <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
                {Object.entries(personality).map(([key, value]) => <Chip key={key} size="small" variant="outlined" label={`${personalityLabels[key] || key} ${String(value)}`} />)}
              </Stack>
            </DetailPanel>
          ) : null}
        </Box>
      </Stack>
    );
  }
  const chat = asRecord(item.payload?.chat);
  const preview = getPreviewPayload(item);
  const bundledCharacters = getMarketCharacterPreviews(item);
  const chatTypeLabel = getLocalizedLabel(chat.type, chatTypeLabels);
  const chatModeLabel = getLocalizedLabel(chat.mode, chatModeLabels);
  const scenarioLabel = getScenarioLabel(chat.sessionKind);
  const worldState = asRecord(chat.worldState);
  const relationshipCount = Number(preview.relationshipCount || asArray(chat.relationshipLedger).length || 0);
  const memoryCount = Number(preview.memoryCount || asArray(chat.layeredMemories).length || 0);
  return (
    <Stack spacing={1.5}>
      <SurfaceCard contentSx={{ p: 1.5, display: 'grid', gap: 1, '&:last-child': { pb: 1.5 } }}>
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
          <Chip size="small" label={kindLabels[item.kind]} />
          {chatTypeLabel ? <Chip size="small" variant="outlined" label={chatTypeLabel} /> : null}
          {chatModeLabel ? <Chip size="small" variant="outlined" label={chatModeLabel} /> : null}
          {scenarioLabel ? <Chip size="small" variant="outlined" label={scenarioLabel} /> : null}
          <MetricChip label="角色" value={bundledCharacters.length || preview.characterCount} />
          <MetricChip label="关系" value={relationshipCount} />
          <MetricChip label="记忆" value={memoryCount} />
        </Stack>
        <Typography variant="h6" sx={{ fontWeight: 900, lineHeight: 1.25 }}>{getChatTitle(item)}</Typography>
        {renderTextBlock('主题', chat.topic || chat.topicSeed || item.summary || item.title, 520)}
      </SurfaceCard>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: bundledCharacters.length ? '1.2fr 0.8fr' : '1fr' }, gap: 1.25 }}>
        {(compactText(chat.style) || compactText(worldState.mood) || compactText(worldState.focus)) ? (
          <DetailPanel title="聊天配置">
            {renderTextBlock('风格', chat.style, 260)}
            {renderTextBlock('氛围', worldState.mood, 220)}
            {renderTextBlock('焦点', worldState.focus, 220)}
          </DetailPanel>
        ) : null}
        {bundledCharacters.length ? (
          <DetailPanel title="包含角色">
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 0.75 }}>
              {bundledCharacters.slice(0, 12).map((entry, index) => (
                <AvatarToken
                  key={String(entry.localId || entry.name || index)}
                  name={compactText(entry.name, 40) || `角色 ${index + 1}`}
                  avatar={compactText(entry.avatar, 5000)}
                />
              ))}
            </Box>
          </DetailPanel>
        ) : null}
      </Box>
    </Stack>
  );
}
function AvatarToken({ name, avatar }: { name: string; avatar?: string }) {
  const avatarValue = compactText(avatar, 5000);
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
      <Avatar src={isImageValue(avatarValue) ? avatarValue : undefined} sx={{ width: 24, height: 24, fontSize: 12 }}>
        {isImageValue(avatarValue) ? undefined : avatarValue.slice(0, 1) || name.slice(0, 1)}
      </Avatar>
      <Typography variant="caption" noWrap>{name}</Typography>
    </Stack>
  );
}

function MarketTemplateCard({ item, loading, onOpen }: { item: MarketItem; loading?: boolean; onOpen: (item: MarketItem) => void }) {
  const cardImage = getCardImage(item);
  const avatar = getAvatarValue(item);
  const description = getCardDescription(item);
  const preview = getPreviewPayload(item);
  const chat = getPreviewChat(item);
  const bundledCharacters = getMarketCharacterPreviews(item);
  const characterCount = Number(preview.characterCount || bundledCharacters.length || 0);
  const relationshipCount = Number(preview.relationshipCount || 0);
  const memoryCount = Number(preview.memoryCount || 0);
  const cardTitle = item.kind === 'character_template' ? item.title : getChatTitle(item);
  const chatTypeLabel = getLocalizedLabel(chat.type, chatTypeLabels);
  const chatModeLabel = getLocalizedLabel(chat.mode, chatModeLabels);
  const scenarioLabel = getScenarioLabel(chat.sessionKind);
  const metaChips = [
    chatTypeLabel,
    chatModeLabel,
    characterCount ? `角色 ${characterCount}` : '',
    relationshipCount ? `关系 ${relationshipCount}` : '',
    memoryCount ? `记忆 ${memoryCount}` : '',
  ].filter(Boolean);

  return (
    <SurfaceCard
      onClick={() => onOpen(item)}
      sx={{
        breakInside: 'avoid',
        mb: 1.5,
        cursor: loading ? 'default' : 'pointer',
        position: 'relative',
        overflow: 'hidden',
        '&:hover': {
          borderColor: loading ? undefined : 'primary.main',
          transform: loading ? undefined : 'translateY(-1px)',
          boxShadow: (theme) => theme.palette.mode === 'light'
            ? '0 18px 46px rgba(15,23,42,0.10)'
            : '0 20px 52px rgba(0,0,0,0.38)',
        },
      }}
      contentSx={{
        p: 1.25,
        display: 'grid',
        gap: 1,
        alignContent: 'start',
        '&:last-child': { pb: 1.25 },
      }}
    >
      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Avatar src={isImageValue(avatar) ? avatar : undefined}>
          {isImageValue(avatar) ? undefined : avatar.slice(0, 2) || item.title.slice(0, 1)}
        </Avatar>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontWeight: 900 }} noWrap>{cardTitle}</Typography>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.75, mt: 0.25 }}>
            <Chip size="small" label={kindLabels[item.kind]} />
            {item.kind !== 'character_template' && scenarioLabel ? <Chip size="small" variant="outlined" label={scenarioLabel} /> : null}
          </Stack>
        </Box>
      </Stack>

      {item.kind === 'character_template' && cardImage ? (
        <Box
          component="img"
          src={cardImage}
          alt={item.title}
          sx={{
            width: '100%',
            aspectRatio: '3 / 4',
            objectFit: 'cover',
            borderRadius: 1,
            bgcolor: 'action.hover',
            border: '1px solid',
            borderColor: 'divider',
          }}
        />
      ) : null}

      {item.kind !== 'character_template' ? (
        <Box
          sx={{
            p: 1.25,
            minHeight: 118,
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: 'action.hover',
            display: 'grid',
            gap: 1,
            alignContent: 'start',
          }}
        >
          {description ? <Typography variant="body2" sx={{ fontWeight: 700, wordBreak: 'break-word' }}>{description}</Typography> : null}
          {metaChips.length ? (
            <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
              {metaChips.slice(0, 5).map((label) => <Chip key={label} size="small" variant="outlined" label={label} />)}
            </Stack>
          ) : null}
          {bundledCharacters.length ? (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 0.75 }}>
              {bundledCharacters.slice(0, 6).map((entry, index) => (
                <AvatarToken
                  key={String(entry.localId || entry.name || index)}
                  name={compactText(entry.name, 40) || `角色 ${index + 1}`}
                  avatar={compactText(entry.avatar, 5000)}
                />
              ))}
            </Box>
          ) : null}
        </Box>
      ) : null}

      {item.kind === 'character_template' && description ? (
        <Typography variant="body2" color="text.secondary" sx={{ minHeight: 42, wordBreak: 'break-word' }}>{description}</Typography>
      ) : null}

      {item.kind === 'character_template' ? (
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
          {asArray(getPreviewCharacter(item).expertise).slice(0, 4).map((entry) => <Chip key={String(entry)} size="small" variant="outlined" label={String(entry)} />)}
        </Stack>
      ) : null}

      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mt: 0.5 }}>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', color: 'text.secondary' }}>
          <FileDownloadOutlinedIcon sx={{ fontSize: 17 }} />
          <Typography variant="caption">{item.importedCount}</Typography>
        </Stack>
      </Stack>
      {loading ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            display: 'grid',
            placeItems: 'center',
            bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.48)' : 'rgba(10,10,15,0.36)',
            backdropFilter: 'blur(8px) saturate(1.05)',
            WebkitBackdropFilter: 'blur(8px) saturate(1.05)',
          }}
        >
          <CircularProgress size={28} thickness={4} />
        </Box>
      ) : null}
    </SurfaceCard>
  );
}

function normalizeNameKey(name: unknown) {
  return compactText(name, 200).toLowerCase();
}

function resolveUniqueName(name: unknown, usedNames: Set<string>) {
  const baseName = compactText(name, 80) || '未命名角色';
  let candidate = baseName;
  let suffix = 2;
  while (usedNames.has(normalizeNameKey(candidate))) {
    candidate = `${baseName}（${suffix}）`;
    suffix += 1;
  }
  usedNames.add(normalizeNameKey(candidate));
  return candidate;
}

interface MarketDuplicateInfo {
  isOwnTemplate: boolean;
  characterMatches: string[];
  chatMatches: string[];
}

function buildMarketDuplicateInfo(params: {
  item: MarketItem | null;
  currentUserId?: string | null;
  characters: AICharacter[];
  chats: GroupChat[];
}): MarketDuplicateInfo {
  const { item, currentUserId, characters, chats } = params;
  if (!item) return { isOwnTemplate: false, characterMatches: [], chatMatches: [] };
  const isOwnTemplate = Boolean(currentUserId && item.ownerUserId === currentUserId);
  const characterMatches = new Set<string>();
  const chatMatches = new Set<string>();
  const characterNameKeys = new Set<string>();
  const chatNameKey = normalizeNameKey(getChatTitle(item));

  if (item.kind === 'character_template') {
    const character = getCharacterFromItem(item);
    const nameKey = normalizeNameKey(character.name || item.title);
    if (nameKey) characterNameKeys.add(nameKey);
  } else if (item.kind === 'bundle_template') {
    getMarketCharacterPreviews(item).forEach((entry) => {
      const nameKey = normalizeNameKey(entry.name);
      if (nameKey) characterNameKeys.add(nameKey);
    });
  }

  characters.forEach((character) => {
    const sameSource = character.sourceMarketItemId === item.id;
    const sameName = characterNameKeys.has(normalizeNameKey(character.name));
    if (sameSource || sameName) characterMatches.add(character.name || '未命名角色');
  });
  chats.forEach((chat) => {
    const sameSource = chat.sourceMarketItemId === item.id;
    const sameName = Boolean(chatNameKey && normalizeNameKey(chat.name || chat.topic) === chatNameKey);
    if (sameSource || sameName) chatMatches.add(chat.name || chat.topic || '未命名聊天');
  });

  return {
    isOwnTemplate,
    characterMatches: Array.from(characterMatches).slice(0, 8),
    chatMatches: Array.from(chatMatches).slice(0, 6),
  };
}

function hasMarketDuplicateInfo(info: MarketDuplicateInfo) {
  return info.isOwnTemplate || info.characterMatches.length > 0 || info.chatMatches.length > 0;
}

function DuplicateNotice({ info, kind }: { info: MarketDuplicateInfo; kind: MarketItemKind }) {
  if (!hasMarketDuplicateInfo(info)) return null;
  const title = info.isOwnTemplate ? '这是你提交的模板' : '检测到可能重复';
  const actionText = kind === 'bundle_template' ? '继续导入会创建一组新的角色和聊天副本。' : '继续导入会创建新的本地副本。';
  return (
    <Alert severity={info.isOwnTemplate ? 'info' : 'warning'} sx={{ borderRadius: 1 }}>
      <Stack spacing={0.75}>
        <Typography variant="body2" sx={{ fontWeight: 800 }}>{title}</Typography>
        <Typography variant="body2">{actionText}</Typography>
        {info.characterMatches.length ? (
          <Box>
            <Typography variant="caption" color="text.secondary">已有角色</Typography>
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.75 }}>
              {info.characterMatches.map((name) => <Chip key={name} size="small" variant="outlined" label={name} />)}
            </Stack>
          </Box>
        ) : null}
        {info.chatMatches.length ? (
          <Box>
            <Typography variant="caption" color="text.secondary">已有聊天</Typography>
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.75 }}>
              {info.chatMatches.map((name) => <Chip key={name} size="small" variant="outlined" label={name} />)}
            </Stack>
          </Box>
        ) : null}
      </Stack>
    </Alert>
  );
}

async function importBundleTemplate(item: MarketItem) {
  const bundledEntries = getBundledCharacterEntries(item);
  const previews = buildBundledCharacterPreview(item);
  const previewByLocalId = new Map(previews.map((character) => [character.id, character]));
  const characterStore = useCharacterStore.getState();
  const usedNames = new Set(characterStore.characters.map((character) => normalizeNameKey(character.name)).filter(Boolean));
  const createdCharacters = await characterStore.addCharacters(bundledEntries.map((entry) => {
    const preview = previewByLocalId.get(entry.localId);
    if (!preview) {
      throw new Error('组合包角色数据不完整');
    }
    const { id: _id, isPreset: _isPreset, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = preview;
    void _id;
    void _isPreset;
    void _createdAt;
    void _updatedAt;
    return {
      ...draft,
      name: resolveUniqueName(draft.name, usedNames),
      sourceMarketItemId: item.id,
      sourceMarketItemVersion: item.payloadVersion,
      sourceMarketKind: item.kind,
    };
  }));
  const creationIdMap = new Map(bundledEntries.map((entry, index) => [entry.localId, createdCharacters[index]?.id || entry.localId]));
  const importedChatRuntime = remapIds(buildImportedChatDraft(item), creationIdMap) as Partial<GroupChat>;
  const memberIds = Array.isArray(importedChatRuntime.memberIds)
    ? importedChatRuntime.memberIds.map((memberId) => creationIdMap.get(memberId) || memberId)
    : createdCharacters.map((character) => character.id);
  const normalizedChat = normalizeConversation({
    ...importedChatRuntime,
    id: 'market-import-draft',
    createdAt: 0,
    updatedAt: 0,
    lastMessageAt: 0,
    type: (importedChatRuntime.type || 'group') as ConversationType,
    mode: (importedChatRuntime.mode || 'open_chat') as ConversationMode,
    name: compactText(importedChatRuntime.name || getChatTitle(item), 120) || '未命名聊天',
    topic: compactText(importedChatRuntime.topic || importedChatRuntime.topicSeed || item.summary || item.title, 1000),
    style: (importedChatRuntime.style || 'free') as ChatStyle,
    runtimeEvolutionIntensity: (importedChatRuntime.runtimeEvolutionIntensity || 'balanced') as RuntimeEvolutionIntensity,
    memberIds,
    operatorIds: Array.isArray(importedChatRuntime.operatorIds) ? importedChatRuntime.operatorIds.map((memberId) => creationIdMap.get(memberId) || memberId) : [],
    speed: Number(importedChatRuntime.speed || 1),
    isActive: Boolean(importedChatRuntime.isActive),
    allowIntervention: importedChatRuntime.allowIntervention ?? true,
    topicSeed: compactText(importedChatRuntime.topicSeed, 1000),
    sourceMarketItemId: item.id,
    sourceMarketItemVersion: item.payloadVersion,
    sourceMarketKind: item.kind,
  } as Parameters<typeof normalizeConversation>[0]);
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, lastMessageAt: _lastMessageAt, ...chatDraft } = normalizedChat;
  void _id;
  void _createdAt;
  void _updatedAt;
  void _lastMessageAt;
  const chat = await useChatStore.getState().addChat(chatDraft);
  void marketApi.recordImported(item.id).catch((error) => {
    console.warn('[market:record-imported:error]', error);
  });
  return chat;
}

export default function MarketPage() {
  const navigate = useNavigate();
  const { setHeaderActions, setHeaderBackAction, setHeaderTitle } = useLayoutHeaderActions();
  const currentUserId = useAuthStore((state) => state.user?.id || null);
  const marketAccessEntitled = useAuthStore((state) => state.user?.marketAccessEntitled === true);
  const characters = useCharacterStore((state) => state.characters);
  const chats = useChatStore((state) => state.chats);
  const [kind, setKind] = useState<MarketItemKind | ''>('');
  const [items, setItems] = useState<MarketItem[]>([]);
  const [selected, setSelected] = useState<MarketItem | null>(null);
  const [detail, setDetail] = useState<MarketItem | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!marketAccessEntitled) {
      setItems([]);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await marketApi.list({ kind: kind || undefined, limit: 80 });
      setItems(result.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载市场失败');
    } finally {
      setLoading(false);
    }
  }, [kind, marketAccessEntitled]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setHeaderTitle('市场');
    setHeaderBackAction(null);
    if (!marketAccessEntitled) {
      setHeaderActions(null);
      return () => {
        setHeaderTitle(null);
        setHeaderBackAction(null);
        setHeaderActions(null);
      };
    }
    setHeaderActions(
      <Tooltip title="刷新">
        <span>
          <IconButton aria-label="刷新市场" onClick={() => void load()} disabled={loading} size="small">
            <RefreshIcon />
          </IconButton>
        </span>
      </Tooltip>
    );
    return () => {
      setHeaderTitle(null);
      setHeaderBackAction(null);
      setHeaderActions(null);
    };
  }, [load, loading, marketAccessEntitled, setHeaderActions, setHeaderBackAction, setHeaderTitle]);

  const openImport = async (item: MarketItem) => {
    if (!marketAccessEntitled) return;
    if (detailLoadingId) return;
    setSelected(item);
    setDetail(null);
    setDetailLoadingId(item.id);
    setError('');
    try {
      const result = await marketApi.detail(item.id);
      setDetail(result.item);
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : '加载模板详情失败');
    } finally {
      setDetailLoadingId(null);
    }
  };

  const importSelected = async () => {
    if (!marketAccessEntitled) return;
    if (!detail?.payload) return;
    setImporting(true);
    setError('');
    try {
      if (detail.kind === 'bundle_template') {
        const chat = await importBundleTemplate(detail);
        setSelected(null);
        navigate(`/chats/${chat.id}`);
        return;
      }
      if (detail.kind === 'character_template') {
        setSelected(null);
        navigate('/characters/create', { state: { marketImportDraft: { item: detail } } });
        return;
      }
      setSelected(null);
      navigate('/chats/create', { state: { marketImportDraft: { item: detail } } });
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const closeDialog = () => {
    if (importing) return;
    setSelected(null);
    setDetail(null);
  };
  const duplicateInfo = useMemo(() => buildMarketDuplicateInfo({
    item: detail,
    currentUserId,
    characters,
    chats,
  }), [characters, chats, currentUserId, detail]);
  const hasDuplicateWarning = hasMarketDuplicateInfo(duplicateInfo);
  const primaryActionText = hasDuplicateWarning
    ? (detail?.kind === 'bundle_template' ? '创建副本' : '创建副本并编辑')
    : (detail?.kind === 'bundle_template' ? '导入' : '导入并编辑');
  const importingText = detail?.kind === 'bundle_template' ? '导入中' : '打开中';

  if (!marketAccessEntitled) {
    return (
      <AccessState
        kind="forbidden"
        title="无法访问市场"
        description="当前账号未开通市场浏览与下载权限。"
        actions={[
          accessStateActions.home('返回首页', () => navigate('/')),
        ]}
      />
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, display: 'grid', gap: 2 }}>
      <Box sx={{ ...buildFloatingTabContainerSx(), mb: 0 }}>
        <FloatingSegmentedTabs
          value={kind}
          onChange={setKind}
          scrollContentToTopOnChange
          equalWidth={false}
          items={kindFilterOptions}
        />
      </Box>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Box
        sx={{
          columnCount: { xs: 1, sm: 2, lg: 3, xl: 4 },
          columnGap: 1.5,
        }}
      >
        {items.map((item) => (
          <MarketTemplateCard key={item.id} item={item} loading={detailLoadingId === item.id} onOpen={(nextItem) => void openImport(nextItem)} />
        ))}
      </Box>
      {!items.length && !loading ? <Alert severity="info">暂无已审核市场模板</Alert> : null}

      <Dialog
        open={Boolean(selected && detail)}
        onClose={closeDialog}
        maxWidth="md"
        fullWidth
        sx={{
          '& .MuiDialog-paper': {
            borderRadius: 1,
            border: '1px solid',
            borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
            bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.82)' : 'rgba(18,20,28,0.86)',
            backdropFilter: 'blur(22px) saturate(1.16)',
            WebkitBackdropFilter: 'blur(22px) saturate(1.16)',
          },
        }}
      >
        <DialogTitle sx={{ pb: 1.25 }}>
          <Stack spacing={0.75}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
              <Typography variant="h6" sx={{ fontWeight: 900, minWidth: 0 }} noWrap>{selected?.title || '模板详情'}</Typography>
              {selected ? <Chip size="small" label={kindLabels[selected.kind]} /> : null}
            </Stack>
            {selected?.summary ? <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-word' }}>{compactText(selected.summary, 180)}</Typography> : null}
          </Stack>
        </DialogTitle>
        <DialogContent sx={{ p: 0, bgcolor: 'transparent', maxHeight: 'min(76vh, 760px)', overflowY: 'auto' }}>
          <Stack spacing={1.5} sx={{ px: { xs: 2, sm: 3 }, pt: 1, pb: 2 }}>
            {detail ? <DuplicateNotice info={duplicateInfo} kind={detail.kind} /> : null}
            {detail ? <MarketItemDetail item={detail} /> : null}
          {detail ? <Divider /> : null}
          </Stack>
        </DialogContent>
        <DialogActions
          sx={{
            px: { xs: 2, sm: 3 },
            py: 2,
            justifyContent: 'flex-end',
            gap: 1,
            flexWrap: 'wrap',
            borderTop: 1,
            borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
            bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.74)' : 'rgba(20,22,30,0.74)',
            backdropFilter: 'blur(18px) saturate(1.08)',
            WebkitBackdropFilter: 'blur(18px) saturate(1.08)',
          }}
        >
          <Button onClick={closeDialog} disabled={importing}>关闭</Button>
          <Button variant="contained" onClick={() => void importSelected()} disabled={importing || !detail}>
            {importing ? importingText : primaryActionText}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
