import { Avatar, Box, Button, Collapse, Divider, GlobalStyles, Portal, Stack, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { AICharacter } from '../../types/character';
import type { GroupChat } from '../../types/chat';
import { isImageAvatar } from '../../utils/avatar';

export type ProfilePreviewKind = 'character' | 'chat';

interface ProfilePreviewOverlayProps {
  open: boolean;
  kind: ProfilePreviewKind;
  anchorRect: DOMRect | null;
  anchorElement?: HTMLElement | null;
  character?: AICharacter | null;
  chat?: { name: string } & Partial<Pick<GroupChat, 'id' | 'topic' | 'style' | 'mode' | 'type' | 'memberIds' | 'isActive' | 'createdAt' | 'updatedAt' | 'lastMessageAt' | 'sessionKind'>> | null;
  members?: AICharacter[];
  chatStatusLabel?: string;
  actionLabel?: string;
  actionTiming?: 'afterClose' | 'immediate';
  onAction?: () => void;
  onSendMessage?: () => Promise<void>;
  onClose: () => void;
}

const panelWidth = 360;
const panelMaxHeight = 540;
const openDurationMs = 320;
const closeDurationMs = 200;
const heroDurationMs = 400;
const titleHeroDurationMs = 380;
const contentDurationMs = 170;
const collapseDurationMs = 190;
const viewportMargin = 16;
const panelPadding = 12.8;
const characterHeroAvatarSize = 64;
const characterHeroAvatarCenter = panelPadding + characterHeroAvatarSize / 2;
const chatTitleTargetTop = panelPadding + 2;

const panelSx: SxProps<Theme> = {
  position: 'fixed',
  zIndex: 1401,
  width: { xs: 'calc(100vw - 32px)', sm: panelWidth },
  maxHeight: `min(${panelMaxHeight}px, calc(100dvh - 32px))`,
  overflow: 'auto',
  borderRadius: 3,
  border: '1px solid',
  borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.09)' : 'rgba(226,232,240,0.11)',
  bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.78)' : 'rgba(18,20,26,0.78)',
  boxShadow: (theme) => theme.palette.mode === 'light'
    ? '0 24px 64px rgba(15,23,42,0.16), 0 8px 22px rgba(15,23,42,0.08), 0 1px 0 rgba(255,255,255,0.82) inset'
    : '0 26px 70px rgba(0,0,0,0.40), 0 9px 26px rgba(0,0,0,0.24), 0 1px 0 rgba(255,255,255,0.08) inset',
  backdropFilter: 'blur(26px) saturate(1.12)',
  WebkitBackdropFilter: 'blur(26px) saturate(1.12)',
  outline: 'none',
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

const chatStyleLabels: Record<string, string> = {
  free: '轻松',
  debate: '审议',
  brainstorm: '共创',
  roleplay: '演绎',
};

const chatModeLabels: Record<string, string> = {
  open_chat: '开放聊天',
  interview: '访谈',
  group_discussion: '观点审议',
  roundtable: '圆桌审议',
  classroom: '课堂',
  bargaining: '谈判',
  service_roleplay: '服务扮演',
  board_game: '桌面游戏',
  scripted_play: '剧本演绎',
  werewolf: '狼人杀',
  murder_mystery: '剧本杀',
  'open-chat': '开放聊天',
  'direct-chat': '单聊',
  'ai-private-thread': 'AI私聊线程',
  'opinion-review': '观点审议',
  'roundtable-review': '圆桌审议',
  'role-debate': '角色辩论',
  'courtroom-deliberation': '法庭攻防',
  'expert-review': '专家评审',
  'public-inquiry': '公开质询',
  'brainstorm-workshop': '创意生成',
  'task-retrospective': '任务复盘',
  'story-reader': '故事阅读',
  'ielts-coach': '学习进步',
  'learning-progress': '学习进步',
  'single-agent-workflow': '单智能体工作流',
  'multi-agent-workflow': '多智能体工作流',
  'panel-interview': '访谈',
  'werewolf-classic': '狼人杀',
  'murder-mystery': '剧本杀',
  'board-game': '桌面游戏',
};

function labelFromMap(value: string | undefined, labels: Record<string, string>) {
  if (!value) return '';
  return labels[value] || value;
}

function buildNaturalState(character: AICharacter) {
  const mood = character.soulState?.mood;
  const emotional = character.emotionalState;
  const pleasure = typeof mood?.pleasure === 'number' ? mood.pleasure : 0.5;
  const arousal = typeof mood?.arousal === 'number' ? mood.arousal : 0.45;
  const irritation = emotional?.irritation ?? 0;
  const insecurity = emotional?.insecurity ?? 0;
  const excitement = emotional?.excitement ?? 0;

  if (irritation > 0.62) return '有些烦躁';
  if (insecurity > 0.62) return '略显不安';
  if (excitement > 0.68 || arousal > 0.72) return '兴致很高';
  if (pleasure > 0.68) return '心情不错';
  if (pleasure < 0.32) return '情绪偏低';
  if (arousal < 0.28) return '比较安静';
  return '状态平稳';
}

function InfoRow({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '58px minmax(0, 1fr)', columnGap: 0.75, alignItems: 'start' }}>
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.75 }}>{label}</Typography>
      <Typography variant="body2" sx={{ minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</Typography>
    </Box>
  );
}

function ExpandableInfoRow({ label, value, maxLines = 5 }: { label: string; value?: string | null; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const text = String(value || '').trim();
  const shouldCollapse = text.length > 90;
  if (!text) return null;
  return (
    <Box
      component={shouldCollapse ? 'button' : 'div'}
      type={shouldCollapse ? 'button' : undefined}
      onClick={shouldCollapse ? () => setExpanded((current) => !current) : undefined}
      sx={{
        display: 'grid',
        gridTemplateColumns: '58px minmax(0, 1fr)',
        columnGap: 0.75,
        alignItems: 'start',
        border: 0,
        bgcolor: 'transparent',
        p: 0,
        textAlign: 'left',
        cursor: shouldCollapse ? 'pointer' : 'default',
        color: 'inherit',
        font: 'inherit',
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 3, borderRadius: 1 },
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.75 }}>{label}</Typography>
      <Box sx={{ minWidth: 0 }}>
        <Collapse in={expanded || !shouldCollapse} collapsedSize={shouldCollapse ? maxLines * 22 : 0} timeout={collapseDurationMs} easing={{ enter: 'cubic-bezier(0.18, 0.92, 0.24, 1)', exit: 'cubic-bezier(0.34, 0, 0.66, 0.2)' }}>
          <Typography
            variant="body2"
            sx={{
              minWidth: 0,
              overflowWrap: 'anywhere',
              whiteSpace: expanded || !shouldCollapse ? 'pre-wrap' : 'normal',
              display: expanded || !shouldCollapse ? 'block' : '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: expanded || !shouldCollapse ? 'unset' : maxLines,
              overflow: 'hidden',
              opacity: expanded || !shouldCollapse ? 1 : 0.84,
              transform: expanded || !shouldCollapse ? 'translateY(0)' : 'translateY(-2px)',
              transition: `opacity 140ms ease, transform ${collapseDurationMs}ms cubic-bezier(0.18, 0.92, 0.24, 1)`,
            }}
          >
            {text}
          </Typography>
        </Collapse>
      </Box>
    </Box>
  );
}

function CharacterPreview({ character }: { character: AICharacter }) {
  const expertise = Array.isArray(character.expertise) ? character.expertise.filter(Boolean).slice(0, 5) : [];
  const initials = character.name.slice(0, 1);
  const naturalState = buildNaturalState(character);
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1.4} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Box
          className="profile-preview-hero-avatar"
          sx={{
            width: characterHeroAvatarSize,
            height: characterHeroAvatarSize,
            flexShrink: 0,
            borderRadius: '50%',
            transformOrigin: '50% 50%',
          }}
        >
          {isImageAvatar(character.avatar) ? (
            <Avatar src={character.avatar} alt={character.name} sx={{ width: 64, height: 64 }} />
          ) : (
            <Avatar sx={{ width: 64, height: 64, bgcolor: 'primary.main', fontSize: 26, fontWeight: 800 }}>{initials}</Avatar>
          )}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontWeight: 820, lineHeight: 1.18, letterSpacing: 0 }} noWrap>{character.name}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.35 }} noWrap>
            {character.group || (character.isPreset ? '预设角色' : '自定义角色')}
          </Typography>
        </Box>
      </Stack>

      <Divider />
      <Stack spacing={0.9}>
        <InfoRow label="当前状态" value={naturalState} />
        <InfoRow label="专业领域" value={expertise.join('、')} />
        <ExpandableInfoRow label="说话风格" value={character.speakingStyle} />
        <ExpandableInfoRow label="背景" value={character.background} />
      </Stack>
    </Stack>
  );
}

function ChatPreview({ chat, members = [], statusLabel }: { chat: NonNullable<ProfilePreviewOverlayProps['chat']>; members?: AICharacter[]; statusLabel?: string }) {
  const [membersExpanded, setMembersExpanded] = useState(false);
  const [topicExpanded, setTopicExpanded] = useState(false);
  const visibleMembers = members.slice(0, 8);
  const topic = String(chat.topic || '').trim();
  const shouldCollapseTopic = topic.length > 90;
  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography className="profile-preview-hero-title" variant="h6" sx={{ fontWeight: 820, lineHeight: 1.18, letterSpacing: 0 }}>{chat.name}</Typography>
      </Box>
      {visibleMembers.length ? (
        <Box>
          <Stack
            component="button"
            type="button"
            direction="row"
            spacing={-0.8}
            onClick={() => setMembersExpanded((value) => !value)}
            sx={{
              pl: 0.35,
              border: 0,
              bgcolor: 'transparent',
              cursor: 'pointer',
              p: 0,
              m: 0,
              maxWidth: '100%',
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 3, borderRadius: 2 },
            }}
          >
            {visibleMembers.map((member) => (
              <Avatar
                key={member.id}
                src={isImageAvatar(member.avatar) ? member.avatar : undefined}
                alt={member.name}
                sx={{ width: 34, height: 34, border: '2px solid', borderColor: 'background.paper', bgcolor: 'primary.main', fontSize: 14 }}
              >
                {member.name.slice(0, 1)}
              </Avatar>
            ))}
          </Stack>
          <Collapse in={membersExpanded} timeout={collapseDurationMs} easing={{ enter: 'cubic-bezier(0.18, 0.92, 0.24, 1)', exit: 'cubic-bezier(0.34, 0, 0.66, 0.2)' }}>
            <Stack spacing={0.75} sx={{ mt: 1 }}>
              {members.map((member) => (
                <Stack
                  key={member.id}
                  direction="row"
                  spacing={1}
                  sx={{
                    alignItems: 'center',
                    minWidth: 0,
                    opacity: membersExpanded ? 1 : 0,
                    transform: membersExpanded ? 'translateY(0)' : 'translateY(-4px)',
                    transition: `opacity 130ms ease, transform ${collapseDurationMs}ms cubic-bezier(0.18, 0.92, 0.24, 1)`,
                    transitionDelay: membersExpanded ? `${Math.min(members.findIndex((item) => item.id === member.id), 6) * 16}ms` : '0ms',
                  }}
                >
                  <Avatar
                    src={isImageAvatar(member.avatar) ? member.avatar : undefined}
                    alt={member.name}
                    sx={{ width: 28, height: 28, bgcolor: 'primary.main', fontSize: 13 }}
                  >
                    {member.name.slice(0, 1)}
                  </Avatar>
                  <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>{member.name}</Typography>
                </Stack>
              ))}
            </Stack>
          </Collapse>
        </Box>
      ) : null}
      <Divider />
      <Stack spacing={0.9}>
        {topic ? (
          <Box
            component={shouldCollapseTopic ? 'button' : 'div'}
            type={shouldCollapseTopic ? 'button' : undefined}
            onClick={shouldCollapseTopic ? () => setTopicExpanded((value) => !value) : undefined}
            sx={{
              display: 'grid',
              gridTemplateColumns: '58px minmax(0, 1fr)',
              columnGap: 0.75,
              alignItems: 'start',
              border: 0,
              bgcolor: 'transparent',
              p: 0,
              textAlign: 'left',
              cursor: shouldCollapseTopic ? 'pointer' : 'default',
              color: 'inherit',
              font: 'inherit',
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 3, borderRadius: 1 },
            }}
          >
            <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.75 }}>话题</Typography>
            <Box sx={{ minWidth: 0 }}>
              <Collapse in={topicExpanded || !shouldCollapseTopic} collapsedSize={shouldCollapseTopic ? 110 : 0} timeout={collapseDurationMs} easing={{ enter: 'cubic-bezier(0.18, 0.92, 0.24, 1)', exit: 'cubic-bezier(0.34, 0, 0.66, 0.2)' }}>
                <Typography
                  variant="body2"
                  sx={{
                    minWidth: 0,
                    overflowWrap: 'anywhere',
                    whiteSpace: topicExpanded || !shouldCollapseTopic ? 'pre-wrap' : 'normal',
                    display: topicExpanded || !shouldCollapseTopic ? 'block' : '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: topicExpanded || !shouldCollapseTopic ? 'unset' : 5,
                    overflow: 'hidden',
                    opacity: topicExpanded || !shouldCollapseTopic ? 1 : 0.82,
                    transform: topicExpanded || !shouldCollapseTopic ? 'translateY(0)' : 'translateY(-2px)',
                    transition: `opacity 140ms ease, transform ${collapseDurationMs}ms cubic-bezier(0.18, 0.92, 0.24, 1)`,
                  }}
                >
                  {topic}
                </Typography>
              </Collapse>
            </Box>
          </Box>
        ) : null}
        <InfoRow label="倾向" value={labelFromMap(chat.style, chatStyleLabels)} />
        <InfoRow label="模式" value={labelFromMap(chat.sessionKind?.scenarioId || chat.mode, chatModeLabels)} />
        <InfoRow label="状态" value={statusLabel} />
      </Stack>
    </Stack>
  );
}

export default function ProfilePreviewOverlay({
  open,
  kind,
  anchorRect,
  anchorElement,
  character,
  chat,
  members = [],
  chatStatusLabel,
  actionLabel,
  actionTiming = 'afterClose',
  onAction,
  onSendMessage,
  onClose,
}: ProfilePreviewOverlayProps) {
  const [rendered, setRendered] = useState(open);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [closing, setClosing] = useState(false);
  const [motionVars, setMotionVars] = useState<CSSProperties | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => (
    typeof window !== 'undefined'
      ? window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      : false
  ));
  const afterCloseRef = useRef<(() => void) | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const hiddenAnchorRef = useRef<{ element: HTMLElement; visibility: string } | null>(null);

  const restoreHiddenAnchor = () => {
    const hiddenAnchor = hiddenAnchorRef.current;
    if (!hiddenAnchor) return;
    hiddenAnchor.element.style.visibility = hiddenAnchor.visibility;
    hiddenAnchorRef.current = null;
  };

  useEffect(() => {
    if (!open) return;
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(false);
    setMotionVars(null);
    setRendered(true);
  }, [open, anchorRect, kind, character?.id, chat?.id]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setPrefersReducedMotion(mediaQuery.matches);
    update();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', update);
      return () => mediaQuery.removeEventListener('change', update);
    }
    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener(update);
  }, []);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
    restoreHiddenAnchor();
  }, []);

  useLayoutEffect(() => {
    if (!rendered || !motionVars || !anchorElement) {
      if (!rendered) restoreHiddenAnchor();
      return;
    }
    if (hiddenAnchorRef.current?.element === anchorElement) return;
    restoreHiddenAnchor();
    hiddenAnchorRef.current = {
      element: anchorElement,
      visibility: anchorElement.style.visibility,
    };
    anchorElement.style.visibility = 'hidden';
  }, [anchorElement, motionVars, rendered]);

  const finishClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(false);
    const afterClose = afterCloseRef.current;
    afterCloseRef.current = null;
    setRendered(false);
    restoreHiddenAnchor();
    onClose();
    afterClose?.();
  };

  useLayoutEffect(() => {
    if (!rendered || motionVars || typeof window === 'undefined') return;
    const measure = () => {
      const panel = panelRef.current;
      if (!panel) return false;

      const panelWidthPx = Math.min(panelWidth, window.innerWidth - viewportMargin * 2);
      const measuredHeight = panel.offsetHeight || panel.getBoundingClientRect().height;
      const panelHeightPx = Math.min(measuredHeight || panelMaxHeight, window.innerHeight - viewportMargin * 2);
      const viewportCenterX = window.innerWidth / 2;
      const viewportCenterY = window.innerHeight / 2;
      const anchorCenterX = anchorRect ? anchorRect.left + anchorRect.width / 2 : viewportCenterX;
      const anchorCenterY = anchorRect ? anchorRect.top + anchorRect.height / 2 : viewportCenterY;
      const anchorWidth = anchorRect?.width || 48;
      const anchorHeight = anchorRect?.height || 48;
      const anchorSize = Math.max(anchorWidth, anchorHeight);
      const preferredLeft = kind === 'character'
        ? anchorCenterX - characterHeroAvatarCenter
        : anchorCenterX - panelWidthPx / 2;
      const preferredTopForChat = anchorRect && anchorRect.bottom + 12 + panelHeightPx <= window.innerHeight - viewportMargin
        ? anchorRect.bottom + 12
        : (anchorRect ? anchorRect.top - panelHeightPx - 12 : viewportCenterY - panelHeightPx / 2);
      const preferredTop = kind === 'character'
        ? anchorCenterY - characterHeroAvatarCenter
        : preferredTopForChat;
      const left = clamp(preferredLeft, viewportMargin, window.innerWidth - panelWidthPx - viewportMargin);
      const top = clamp(preferredTop, viewportMargin, window.innerHeight - panelHeightPx - viewportMargin);
      const startLeft = anchorRect?.left ?? anchorCenterX - anchorWidth / 2;
      const startTop = anchorRect?.top ?? anchorCenterY - anchorHeight / 2;
      const avatarTargetLeft = left + panelPadding;
      const avatarTargetTop = top + panelPadding;
      const titleTargetLeft = left + panelPadding;
      const titleTargetTop = top + chatTitleTargetTop;

      setMotionVars({
        '--profile-preview-left': `${left}px`,
        '--profile-preview-top': `${top}px`,
        '--profile-preview-x': `${startLeft - left}px`,
        '--profile-preview-y': `${startTop - top}px`,
        '--profile-preview-scale-x': String(clamp(anchorWidth / panelWidthPx, 0.08, 1)),
        '--profile-preview-scale-y': String(clamp(anchorHeight / panelHeightPx, 0.06, 1)),
        '--profile-preview-origin-x': '0px',
        '--profile-preview-origin-y': '0px',
        '--profile-preview-hero-left': `${startLeft}px`,
        '--profile-preview-hero-top': `${startTop}px`,
        '--profile-preview-hero-target-left': `${avatarTargetLeft}px`,
        '--profile-preview-hero-target-top': `${avatarTargetTop}px`,
        '--profile-preview-hero-size': `${anchorSize}px`,
        '--profile-preview-hero-open-x': `${startLeft - avatarTargetLeft}px`,
        '--profile-preview-hero-open-y': `${startTop - avatarTargetTop}px`,
        '--profile-preview-hero-open-scale': String(anchorSize / characterHeroAvatarSize),
        '--profile-preview-hero-close-x': `${startLeft - avatarTargetLeft}px`,
        '--profile-preview-hero-close-y': `${startTop - avatarTargetTop}px`,
        '--profile-preview-hero-close-scale': String(anchorSize / characterHeroAvatarSize),
        '--profile-preview-title-left': `${anchorRect?.left ?? anchorCenterX}px`,
        '--profile-preview-title-top': `${anchorRect?.top ?? anchorCenterY}px`,
        '--profile-preview-title-target-left': `${titleTargetLeft}px`,
        '--profile-preview-title-target-top': `${titleTargetTop}px`,
        '--profile-preview-title-open-x': `${(anchorRect?.left ?? anchorCenterX) - titleTargetLeft}px`,
        '--profile-preview-title-open-y': `${(anchorRect?.top ?? anchorCenterY) - titleTargetTop}px`,
        '--profile-preview-title-close-x': `${(anchorRect?.left ?? anchorCenterX) - titleTargetLeft}px`,
        '--profile-preview-title-close-y': `${(anchorRect?.top ?? anchorCenterY) - titleTargetTop}px`,
      } as CSSProperties);
      return true;
    };

    if (measure()) return;
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measure();
    });
  }, [anchorRect, character?.id, chat?.id, kind, motionVars, rendered]);

  if (!rendered) return null;

  const closeWithAnimation = (afterClose?: () => void) => {
    if (closing) return;
    afterCloseRef.current = afterClose || null;
    if (prefersReducedMotion) {
      finishClose();
      return;
    }
    setClosing(true);
    closeTimerRef.current = setTimeout(finishClose, closeDurationMs);
  };

  const canRenderCharacter = kind === 'character' && character;
  const canRenderChat = kind === 'chat' && chat;
  if (!canRenderCharacter && !canRenderChat) return null;

  return (
    <Portal>
      <GlobalStyles styles={{
        '@keyframes profilePreviewPopIn': {
          '0%': {
            opacity: 0.34,
            transform: 'translate(var(--profile-preview-x), var(--profile-preview-y)) scale(var(--profile-preview-scale-x), var(--profile-preview-scale-y))',
            borderRadius: '999px',
            filter: 'blur(0.8px)',
          },
          '72%': {
            opacity: 1,
            transform: 'translate(0, 0) scale(1.002)',
            borderRadius: '24px',
            filter: 'blur(0)',
          },
          '100%': {
            opacity: 1,
            transform: 'translate(0, 0) scale(1)',
            borderRadius: '24px',
            filter: 'blur(0)',
          },
        },
        '@keyframes profilePreviewPopOut': {
          '0%': {
            opacity: 1,
            transform: 'translate(0, 0) scale(1)',
            borderRadius: '24px',
            filter: 'blur(0)',
          },
          '100%': {
            opacity: 0.2,
            transform: 'translate(var(--profile-preview-x), var(--profile-preview-y)) scale(var(--profile-preview-scale-x), var(--profile-preview-scale-y))',
            borderRadius: '999px',
            filter: 'blur(0.8px)',
          },
        },
        '@keyframes profilePreviewContentIn': {
          '0%': { opacity: 0, transform: 'translateY(5px) scale(0.996)' },
          '30%': { opacity: 0, transform: 'translateY(5px) scale(0.996)' },
          '100%': { opacity: 1, transform: 'translateY(0) scale(1)' },
        },
        '@keyframes profilePreviewHeroCloneIn': {
          '0%': {
            transform: 'translate(var(--profile-preview-hero-open-x), var(--profile-preview-hero-open-y)) scale(var(--profile-preview-hero-open-scale))',
            opacity: 1,
          },
          '78%': {
            transform: 'translate(0, 0) scale(1)',
            opacity: 1,
          },
          '100%': {
            transform: 'translate(0, 0) scale(1)',
            opacity: 0,
          },
        },
        '@keyframes profilePreviewHeroCloneOut': {
          '0%': {
            transform: 'translate(0, 0) scale(1)',
            opacity: 1,
          },
          '100%': {
            transform: 'translate(var(--profile-preview-hero-close-x), var(--profile-preview-hero-close-y)) scale(var(--profile-preview-hero-close-scale))',
            opacity: 0,
          },
        },
        '@keyframes profilePreviewTitleCloneIn': {
          '0%': {
            transform: 'translate(var(--profile-preview-title-open-x), var(--profile-preview-title-open-y)) scale(1)',
            opacity: 0.96,
          },
          '76%': {
            transform: 'translate(0, 0) scale(1.004)',
            opacity: 1,
          },
          '100%': {
            transform: 'translate(0, 0) scale(1)',
            opacity: 0,
          },
        },
        '@keyframes profilePreviewTitleCloneOut': {
          '0%': {
            transform: 'translate(0, 0) scale(1)',
            opacity: 1,
          },
          '100%': {
            transform: 'translate(var(--profile-preview-title-close-x), var(--profile-preview-title-close-y)) scale(0.72)',
            opacity: 0,
          },
        },
        '@keyframes profilePreviewHeroReveal': {
          '0%, 58%': {
            opacity: 0,
            transform: 'scale(0.985)',
          },
          '100%': {
            opacity: 1,
            transform: 'scale(1)',
          },
        },
      }} />
      <Box
        onClick={() => closeWithAnimation()}
        sx={{
          position: 'fixed',
          inset: 0,
          zIndex: 1599,
          bgcolor: 'transparent',
          cursor: 'default',
        }}
      />
      <Box
        ref={panelRef}
        style={motionVars || undefined}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        sx={{
          ...panelSx,
          position: 'fixed',
          left: motionVars ? 'var(--profile-preview-left)' : viewportMargin,
          top: motionVars ? 'var(--profile-preview-top)' : viewportMargin,
          zIndex: 1600,
          width: { xs: 'calc(100vw - 32px)', sm: panelWidth },
          p: 1.6,
          transformOrigin: motionVars ? 'var(--profile-preview-origin-x) var(--profile-preview-origin-y)' : '50% 50%',
          pointerEvents: motionVars ? 'auto' : 'none',
          opacity: motionVars ? 1 : 0,
          visibility: 'visible',
          animation: !motionVars || prefersReducedMotion ? 'none' : closing
            ? `${closeDurationMs}ms cubic-bezier(0.34, 0, 0.66, 0.2) both profilePreviewPopOut`
            : `${openDurationMs}ms cubic-bezier(0.2, 0.82, 0.22, 1) both profilePreviewPopIn`,
          '@media (prefers-reduced-motion: reduce)': {
            animation: 'none',
            transform: 'translate(0, 0) scale(1)',
          },
          '& .profile-preview-hero-avatar': {
            animation: !motionVars || closing || prefersReducedMotion ? 'none' : `${heroDurationMs}ms cubic-bezier(0.2, 0.82, 0.22, 1) both profilePreviewHeroReveal`,
            willChange: 'transform, opacity',
          },
          '& .profile-preview-hero-title': {
            transformOrigin: '0 50%',
            animation: !motionVars || closing || prefersReducedMotion ? 'none' : `${titleHeroDurationMs}ms cubic-bezier(0.2, 0.82, 0.22, 1) both profilePreviewHeroReveal`,
            willChange: 'transform, opacity',
          },
        }}
      >
        <Box
          className="profile-preview-content"
          sx={{
            opacity: 1,
            animation: !motionVars || closing || prefersReducedMotion ? 'none' : `${contentDurationMs}ms cubic-bezier(0.2, 0.82, 0.22, 1) 70ms both profilePreviewContentIn`,
            '@media (prefers-reduced-motion: reduce)': {
              animation: 'none',
              opacity: 1,
              transform: 'none',
            },
          }}
        >
          {canRenderCharacter ? <CharacterPreview character={character} /> : null}
          {canRenderChat ? <ChatPreview chat={chat} members={members} statusLabel={chatStatusLabel} /> : null}
          {actionLabel && onAction ? (
            <Stack direction="row" spacing={1} sx={{ mt: 1.6 }}>
              {canRenderCharacter && onSendMessage ? (
                <Button fullWidth variant="outlined" loading={sendingMessage} onClick={async () => {
                  setSendingMessage(true);
                  try {
                    await onSendMessage();
                  } finally {
                    setSendingMessage(false);
                  }
                }}>发消息</Button>
              ) : null}
            <Button
              fullWidth
              variant="contained"
              onClick={() => {
                if (actionTiming === 'immediate') {
                  onAction();
                  return;
                }
                closeWithAnimation(onAction);
              }}
            >
              {actionLabel}
            </Button>
            </Stack>
          ) : null}
        </Box>
      </Box>
      {motionVars && !prefersReducedMotion && canRenderCharacter ? (
        <Box
          aria-hidden
          style={motionVars}
          sx={{
            position: 'fixed',
            left: 'var(--profile-preview-hero-target-left)',
            top: 'var(--profile-preview-hero-target-top)',
            width: characterHeroAvatarSize,
            height: characterHeroAvatarSize,
            zIndex: 1602,
            pointerEvents: 'none',
            borderRadius: '50%',
            overflow: 'hidden',
            animation: closing
              ? `${closeDurationMs}ms cubic-bezier(0.34, 0, 0.66, 0.2) both profilePreviewHeroCloneOut`
              : `${heroDurationMs}ms cubic-bezier(0.2, 0.82, 0.22, 1) both profilePreviewHeroCloneIn`,
            transformOrigin: '0 0',
          }}
        >
          {isImageAvatar(character.avatar) ? (
            <Avatar src={character.avatar} alt="" sx={{ width: '100%', height: '100%' }} />
          ) : (
            <Avatar sx={{ width: '100%', height: '100%', bgcolor: 'primary.main', fontSize: 26, fontWeight: 800 }}>{character.name.slice(0, 1)}</Avatar>
          )}
        </Box>
      ) : null}
      {motionVars && !prefersReducedMotion && canRenderChat ? (
        <Typography
          aria-hidden
          className="profile-preview-title-clone"
          style={motionVars}
          variant="h6"
          sx={{
            position: 'fixed',
            left: 'var(--profile-preview-title-target-left)',
            top: 'var(--profile-preview-title-target-top)',
            zIndex: 1602,
            maxWidth: 320,
            color: 'text.primary',
            fontWeight: 820,
            lineHeight: 1.18,
            letterSpacing: 0,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            transformOrigin: '0 50%',
            animation: closing
              ? `${closeDurationMs}ms cubic-bezier(0.34, 0, 0.66, 0.2) both profilePreviewTitleCloneOut`
              : `${titleHeroDurationMs}ms cubic-bezier(0.2, 0.82, 0.22, 1) both profilePreviewTitleCloneIn`,
          }}
        >
          {chat.name}
        </Typography>
      ) : null}
    </Portal>
  );
}
