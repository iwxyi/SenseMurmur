import { Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useMemo, useState, type ReactNode, type Ref } from 'react';
import ChatInput, { type ChatInputHandle } from '../chat/ChatInput';
import type { SessionInputSurfaceDefinition } from '../../types/chat';
import type { SessionBoardComposerSubmission, SessionFormComposerSubmission, SessionTextComposerSubmission } from '../../types/sessionEngine';
import type { UserDraftActivity } from '../../services/userInputBuffer';
import type { CharacterMention, MessageAttachment } from '../../types/message';
import type { AICharacter } from '../../types/character';
import { composerDraftKey } from '../../services/composerDrafts';
import type { AIModelInputCapabilities } from '../../types/settings';
import type { ComposerState } from '../../types/composerState';

interface SessionComposerHostProps {
  inputHandleRef?: Ref<ChatInputHandle>;
  mentionCharacters?: AICharacter[];
  chatId?: string;
  isStoryRoom?: boolean;
  draftActorId?: string;
  surfaces: SessionInputSurfaceDefinition[];
  onSubmitText: (submission: SessionTextComposerSubmission, surface: SessionInputSurfaceDefinition) => void | Promise<void>;
  onSubmitForm?: (submission: SessionFormComposerSubmission, surface: SessionInputSurfaceDefinition) => void;
  onSubmitBoard?: (submission: SessionBoardComposerSubmission, surface: SessionInputSurfaceDefinition) => void;
  speakAsCharacterName?: string;
  onCloseSpeakAs?: () => void;
  sendingLabel?: string;
  hideSpeakAsChip?: boolean;
  onSendError?: (message: string) => void;
  onOpenPanel?: () => void;
  onDraftActivity?: (activity: UserDraftActivity) => void;
  inputCapabilities?: Partial<AIModelInputCapabilities> | null;
  inputCapabilityWarning?: string;
  autoFocus?: boolean;
  topContent?: ReactNode;
  injectedAttachments?: MessageAttachment[];
  onInjectedAttachmentsConsumed?: () => void;
  isReplyPending?: boolean;
  onStopReply?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  composerState?: ComposerState;
}

function buildInitialFieldState(surfaces: SessionInputSurfaceDefinition[]) {
  return Object.fromEntries(
    surfaces.map((surface) => [
      surface.key,
      Object.fromEntries((surface.fields || []).map((field) => [field.key, ''])),
    ]),
  ) as Record<string, Record<string, string>>;
}

export default function SessionComposerHost({ inputHandleRef, mentionCharacters, chatId, isStoryRoom, draftActorId, surfaces, onSubmitText, onSubmitForm, onSubmitBoard, speakAsCharacterName, onCloseSpeakAs, sendingLabel, hideSpeakAsChip, onSendError, onOpenPanel, onDraftActivity, inputCapabilities, inputCapabilityWarning, autoFocus, topContent, injectedAttachments, onInjectedAttachmentsConsumed, isReplyPending, onStopReply, disabled = false, disabledReason, composerState }: SessionComposerHostProps) {
  const primarySurface = surfaces.find((surface) => surface.type === 'text') || surfaces[0];
  const secondarySurfaces = surfaces.filter((surface) => surface !== primarySurface && (surface.type === 'board' || surface.type === 'form' || surface.type === 'hybrid'));
  const [fieldState, setFieldState] = useState<Record<string, Record<string, string>>>(() => buildInitialFieldState(surfaces));
  const boardSurface = useMemo(() => secondarySurfaces.find((surface) => surface.type === 'board'), [secondarySurfaces]);

  return (
    <Stack spacing={1}>
      {secondarySurfaces.length ? (
        <Stack spacing={1}>
          {secondarySurfaces.map((surface) => surface.type === 'board' ? (
            <Box key={surface.key} sx={{ p: 1.25, borderRadius: 2, bgcolor: 'action.hover' }}>
              <Typography variant="caption" color="text.secondary">{surface.label || 'Board'}</Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1 }}>
                <TextField
                  size="small"
                  label="位置"
                  placeholder="如 A1"
                  value={fieldState[surface.key]?.position || ''}
                  disabled={disabled}
                  onChange={(e) => setFieldState((current) => ({
                    ...current,
                    [surface.key]: { ...(current[surface.key] || {}), position: e.target.value },
                  }))}
                />
                <TextField
                  size="small"
                  label="棋子"
                  placeholder="如 black-1"
                  value={fieldState[surface.key]?.pieceId || ''}
                  disabled={disabled}
                  onChange={(e) => setFieldState((current) => ({
                    ...current,
                    [surface.key]: { ...(current[surface.key] || {}), pieceId: e.target.value },
                  }))}
                />
                <TextField
                  size="small"
                  label="走法"
                  placeholder="如 place / move"
                  value={fieldState[surface.key]?.move || ''}
                  disabled={disabled}
                  onChange={(e) => setFieldState((current) => ({
                    ...current,
                    [surface.key]: { ...(current[surface.key] || {}), move: e.target.value },
                  }))}
                />
                <Button
                  variant="outlined"
                  onClick={() => onSubmitBoard?.({
                    actorId: surface.actorId,
                    position: fieldState[surface.key]?.position,
                    pieceId: fieldState[surface.key]?.pieceId,
                    move: fieldState[surface.key]?.move,
                  }, surface)}
                  disabled={disabled || !onSubmitBoard}
                >
                  提交棋盘动作
                </Button>
              </Stack>
            </Box>
          ) : (
            <Box key={surface.key} sx={{ p: 1.25, borderRadius: 2, bgcolor: 'action.hover' }}>
              <Typography variant="caption" color="text.secondary">{surface.label || 'Form'}</Typography>
              <Stack spacing={1} sx={{ mt: 1 }}>
                {(surface.fields || []).map((field) => (
                  <TextField
                    key={`${surface.key}-${field.key}`}
                    size="small"
                    select={field.type === 'single_select'}
                    type={field.type === 'number' ? 'number' : 'text'}
                    multiline={field.type === 'textarea'}
                    minRows={field.type === 'textarea' ? 3 : undefined}
                    label={field.label}
                    placeholder={field.placeholder}
                    value={fieldState[surface.key]?.[field.key] || ''}
                    disabled={disabled}
                    onChange={(e) => setFieldState((current) => ({
                      ...current,
                      [surface.key]: {
                        ...(current[surface.key] || {}),
                        [field.key]: e.target.value,
                      },
                    }))}
                  >
                    {field.type === 'single_select'
                      ? (field.options || []).map((option) => (
                        <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                      ))
                      : null}
                  </TextField>
                ))}
                <Button
                  variant="outlined"
                  onClick={() => onSubmitForm?.({ actorId: surface.actorId, fields: fieldState[surface.key] || {} }, surface)}
                  disabled={disabled || !onSubmitForm}
                >
                  提交表单动作
                </Button>
              </Stack>
            </Box>
          ))}
        </Stack>
      ) : null}

      {!primarySurface || primarySurface.type !== 'text' ? (
        <ChatInput
          inputHandleRef={inputHandleRef}
          key={composerDraftKey(chatId || '', `fallback:${draftActorId || ''}`)}
          mentionCharacters={mentionCharacters}
          draftKey={chatId ? composerDraftKey(chatId, `fallback:${draftActorId || ''}`) : undefined}
          mode={speakAsCharacterName ? 'speakAs' : 'memberSpeak'}
          isStoryRoom={isStoryRoom}
          characterName={speakAsCharacterName || undefined}
          onSend={(content, attachments?: MessageAttachment[], mentions?: CharacterMention[]) => onSubmitText({ content, attachments, mentions }, { key: 'fallback-text', type: 'text', mode: speakAsCharacterName ? 'speakAs' : 'memberSpeak' })}
          onClose={speakAsCharacterName ? onCloseSpeakAs : undefined}
          sendingLabel={sendingLabel}
          hideSpeakAsChip={hideSpeakAsChip}
          onSendError={onSendError}
          onOpenPanel={onOpenPanel}
          onDraftActivity={onDraftActivity}
          inputCapabilities={inputCapabilities}
          inputCapabilityWarning={inputCapabilityWarning}
          autoFocus={autoFocus}
          topContent={topContent}
          injectedAttachments={injectedAttachments}
          onInjectedAttachmentsConsumed={onInjectedAttachmentsConsumed}
          isReplyPending={isReplyPending}
          onStopReply={onStopReply}
          disabled={disabled}
          disabledReason={disabledReason}
          composerState={composerState}
        />
      ) : (() => {
        const mode = speakAsCharacterName
          ? 'speakAs'
          : (primarySurface.mode || (primarySurface.capability === 'speak' ? 'memberSpeak' : 'guide'));
        const placeholderOverride = mode === 'speakAs'
          ? undefined
          : (
            primarySurface.placeholder
            || (mode === 'memberSpeak' ? '输入消息' : undefined)
            || (boardSurface ? '输入聊天内容或解释本次操作' : undefined)
          );
        return (
          <ChatInput
            inputHandleRef={inputHandleRef}
            key={composerDraftKey(chatId || '', `${primarySurface.key}:${draftActorId || ''}`)}
            mentionCharacters={mentionCharacters}
            draftKey={chatId ? composerDraftKey(chatId, `${primarySurface.key}:${draftActorId || ''}`) : undefined}
            mode={mode}
            isStoryRoom={isStoryRoom}
            characterName={mode === 'speakAs' ? speakAsCharacterName : undefined}
            placeholderOverride={placeholderOverride}
            onSend={(content, attachments?: MessageAttachment[], mentions?: CharacterMention[]) => onSubmitText({ content, actorId: primarySurface.actorId, attachments, mentions }, primarySurface)}
            onClose={mode === 'speakAs' ? onCloseSpeakAs : undefined}
            sendingLabel={sendingLabel}
            hideSpeakAsChip={hideSpeakAsChip}
            onSendError={onSendError}
            onOpenPanel={onOpenPanel}
            onDraftActivity={onDraftActivity}
            inputCapabilities={inputCapabilities}
            inputCapabilityWarning={inputCapabilityWarning}
            autoFocus={autoFocus}
            topContent={topContent}
            injectedAttachments={injectedAttachments}
            onInjectedAttachmentsConsumed={onInjectedAttachmentsConsumed}
            isReplyPending={isReplyPending}
            onStopReply={onStopReply}
            disabled={disabled}
            disabledReason={disabledReason}
            composerState={composerState}
          />
        );
      })()}
    </Stack>
  );
}
