import { Box, Chip } from '@mui/material';
import type { Message } from '../../types/message';
import type { AssistantArtifactItem } from '../../types/assistantArtifact';
import { useAssistantArtifactStore } from '../../stores/useAssistantArtifactStore';
import AssistantHtmlFrame, { type AssistantHtmlInteractionPayload, type AssistantHtmlRuntimeError } from './AssistantHtmlFrame';
import { logDeveloperDiagnostic } from '../../services/developerDiagnostics';

type ArtifactRef = NonNullable<NonNullable<NonNullable<Message['metadata']>['assistant']>['artifacts']>[number];

function resolveInlineVersion(artifact: AssistantArtifactItem, ref: ArtifactRef) {
  const referenced = artifact.versions.find((version) => version.id === ref.versionId)
    || artifact.versions.find((version) => version.id === artifact.currentVersionId)
    || artifact.versions.at(-1);
  if (!referenced) return null;
  const attempt = artifact.versions
    .filter((version) => version.baseVersionId === referenced.id && (version.stage === 'autosave' || version.stage === 'submitted'))
    .sort((left, right) => (right.updatedAt || right.createdAt) - (left.updatedAt || left.createdAt))[0];
  return attempt || referenced;
}

export default function AssistantHtmlMessageBlock({ artifactRef, onAutosave, onSubmit, onOpenFullscreen, onRequestRepair }: {
  artifactRef: ArtifactRef;
  onAutosave?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onSubmit?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onOpenFullscreen?: (artifactId: string) => void;
  onRequestRepair?: (error: AssistantHtmlRuntimeError) => void | Promise<void>;
}) {
  const artifact = useAssistantArtifactStore((state) => state.items.find((item) => item.id === artifactRef.id && item.deletedAt == null) || null);
  if (!artifact || artifact.kind !== 'html') return null;
  const version = resolveInlineVersion(artifact, artifactRef);
  const manifest = version?.htmlRuntime;
  if (!version || !manifest) return null;
  const isCurrentVersion = version.id === artifact.currentVersionId;
  const hasNewerVersion = !isCurrentVersion;
  const interactive = artifactRef.presentation !== 'fullscreen_html'
    && (manifest.presentation === 'inline' || manifest.presentation === 'both');
  const readOnly = !isCurrentVersion;
  if (interactive) {
    return (
      <Box sx={{ position: 'relative', width: '100%', border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: 'background.paper' }}>
        {hasNewerVersion ? <Chip label="已更新" size="small" color="primary" sx={{ position: 'absolute', top: 8, right: 8, zIndex: 1, pointerEvents: 'none' }} /> : null}
        <AssistantHtmlFrame
          artifactId={artifact.id}
          version={version}
          manifest={manifest}
          inline
          readOnly={readOnly}
          onAutosave={onAutosave}
          onSubmit={onSubmit}
          onOpenFullscreen={() => onOpenFullscreen?.(artifact.id)}
          onRequestRepair={isCurrentVersion ? onRequestRepair : undefined}
        />
      </Box>
    );
  }
  const previewManifest = {
    ...manifest,
    viewport: { preferredHeight: 200, maxInlineHeight: 220 },
  };
  return (
    <Box
      role={onOpenFullscreen ? 'button' : undefined}
      tabIndex={onOpenFullscreen ? 0 : undefined}
      onClick={() => {
        logDeveloperDiagnostic('html-artifact:click', { artifactId: artifact.id, hasOpenHandler: Boolean(onOpenFullscreen), presentation: artifactRef.presentation || null }, 'info', 'chat-window');
        onOpenFullscreen?.(artifact.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          logDeveloperDiagnostic('html-artifact:keyboard-open', { artifactId: artifact.id, hasOpenHandler: Boolean(onOpenFullscreen) }, 'info', 'chat-window');
          onOpenFullscreen?.(artifact.id);
        }
      }}
      sx={{
        position: 'relative',
        width: 'min(100%, 560px)',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: 'background.paper',
        cursor: onOpenFullscreen ? 'pointer' : 'default',
        '&:hover': onOpenFullscreen ? { borderColor: 'primary.main' } : undefined,
      }}
    >
      {hasNewerVersion ? <Chip label="已更新" size="small" color="primary" sx={{ position: 'absolute', top: 8, right: 8, zIndex: 1, pointerEvents: 'none' }} /> : null}
      <AssistantHtmlFrame artifactId={artifact.id} version={version} manifest={previewManifest} inline readOnly interactive={false} onOpenFullscreen={() => onOpenFullscreen?.(artifact.id)} onRequestRepair={isCurrentVersion ? onRequestRepair : undefined} />
    </Box>
  );
}
