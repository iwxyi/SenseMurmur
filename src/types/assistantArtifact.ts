export type AssistantArtifactKind = 'document' | 'code' | 'diagram' | 'html' | 'table' | 'json' | 'text' | 'image';

export type AssistantDataOperationKind = 'query' | 'insert' | 'update' | 'delete' | 'add_column';

export type AssistantDataFilterOperator =
  | 'eq' | 'contains' | 'startsWith' | 'endsWith'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'exists' | 'notExists' | 'isNull' | 'isNotNull';

export type AssistantDataFilter =
  | {
      field: string;
      operator?: AssistantDataFilterOperator;
      value?: unknown;
    }
  | { all: AssistantDataFilter[] }
  | { any: AssistantDataFilter[] }
  | { not: AssistantDataFilter };

export interface AssistantArtifactDataOperation {
  kind: AssistantDataOperationKind;
  artifactId: string;
  baseVersionId?: string | null;
  filePath?: string | null;
  filter?: AssistantDataFilter[];
  values?: Record<string, unknown>;
  column?: string;
  defaultValue?: unknown;
  limit?: number;
  offset?: number;
  sort?: { field: string; direction?: 'asc' | 'desc' };
}

export interface AssistantArtifactTextOperation {
  artifactId: string;
  filePath?: string | null;
  search: string;
  replacement: string;
  replaceAll?: boolean;
  baseVersionId?: string | null;
}

export interface AssistantArtifactVersionOperation {
  kind: 'restore' | 'limit';
  artifactId: string;
  versionId?: string;
  keepCount?: number;
}

export interface AssistantArtifactDataResult {
  operation: AssistantDataOperationKind;
  affectedRows: number;
  totalRows?: number;
  rows?: Array<Record<string, unknown>>;
  format?: 'csv' | 'json';
  columns?: string[];
  truncated?: boolean;
  error?: string;
}

export interface AssistantArtifactMediaRef {
  assetId: string;
  thumbnailAssetId?: string;
  url?: string;
  thumbnailUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  checksum?: string;
  alt?: string;
}

export interface AssistantArtifactFile {
  id: string;
  path: string;
  content: string;
  language?: string | null;
}

export interface AssistantArtifactDataField {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'array' | 'object';
  description?: string;
}

export interface AssistantArtifactDataDescriptor {
  description?: string;
  fields: AssistantArtifactDataField[];
  primaryKey?: string;
}

export type AssistantArtifactVersionStage = 'generated' | 'autosave' | 'submitted' | 'ai_result' | 'user_revision';

export interface AssistantHtmlSubmissionField {
  name: string;
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'single_choice' | 'multi_choice';
  label?: string;
  required?: boolean;
  maxLength?: number;
  options?: string[];
}

export interface AssistantHtmlRuntimeManifest {
  schemaVersion: 1;
  presentation: 'inline' | 'fullscreen' | 'both';
  executionMode: 'declarative' | 'sandboxed_web';
  viewport?: {
    preferredHeight?: number;
    maxInlineHeight?: number;
  };
  autosave?: {
    enabled: true;
    debounceMs?: number;
  };
  submission?: {
    interactionId: string;
    label: string;
    resultType: 'form' | 'quiz' | 'selection' | 'custom';
    fields: AssistantHtmlSubmissionField[];
    sendToAssistant: true;
    createArtifactVersion: true;
  };
}

export interface AssistantArtifactVersion {
  id: string;
  artifactId: string;
  content: string;
  files?: AssistantArtifactFile[];
  language?: string | null;
  sourceMessageId: string;
  baseVersionId?: string | null;
  changeSummary?: string;
  media?: AssistantArtifactMediaRef[];
  htmlRuntime?: AssistantHtmlRuntimeManifest;
  stage?: AssistantArtifactVersionStage;
  interactionState?: Record<string, unknown>;
  updatedAt?: number;
  revision?: number;
  submissionId?: string;
  submittedAt?: number;
  createdAt: number;
  dataDescriptor?: AssistantArtifactDataDescriptor;
}

export interface AssistantArtifactItem {
  id: string;
  chatId: string;
  kind: AssistantArtifactKind;
  title: string;
  summary?: string;
  language?: string | null;
  currentVersionId: string;
  versions: AssistantArtifactVersion[];
  sourceMessageId: string;
  createdAt: number;
  updatedAt: number;
  sortOrder?: number;
  deletedAt?: number | null;
  revision?: number;
  dataDescriptor?: AssistantArtifactDataDescriptor;
}

export interface AssistantArtifactDraft {
  kind: AssistantArtifactKind;
  title: string;
  content: string;
  files?: AssistantArtifactFile[];
  language?: string | null;
  summary?: string;
  targetArtifactId?: string | null;
  action?: 'create' | 'update';
  baseVersionId?: string | null;
  changeSummary?: string;
  media?: AssistantArtifactMediaRef[];
  htmlRuntime?: AssistantHtmlRuntimeManifest;
  versionStage?: AssistantArtifactVersionStage;
  dataDescriptor?: AssistantArtifactDataDescriptor;
}

export type AssistantAgentIntent = 'chat' | 'create' | 'update' | 'clarify' | 'search';
export type AssistantAgentTargetMode = 'single' | 'multi' | 'workspace' | 'selection' | 'unknown';
export type AssistantResponseExperience = 'direct_answer' | 'source_code' | 'structured_input' | 'interactive_workspace' | 'visual_explanation';

export interface AssistantAgentLocalFileRef {
  directoryId: string;
  path: string;
}

export interface AssistantAgentWorkspaceScanRequest {
  directoryIds?: string[];
  pathPrefix?: string;
  nameContains?: string;
  extension?: string;
  minSizeBytes?: number;
  maxSizeBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
}

export interface AssistantAgentNetworkRequest {
  url: string;
  mode: 'readable' | 'source' | 'binary';
  action?: 'read' | 'store' | 'export';
  recursive?: boolean;
  extractArchives?: boolean;
  destination?: 'session' | 'workspace' | 'device';
  workspaceId?: string;
  destinationPath?: string;
  fileName?: string;
  conflictPolicy?: 'rename' | 'skip' | 'overwrite';
}

export interface AssistantAgentLocalFileContext extends AssistantAgentLocalFileRef {
  name: string;
  mimeType?: string;
  sizeBytes: number;
  content: string;
  truncated: boolean;
  originalLength: number;
}

export interface AssistantAgentChangePlan {
  intent: AssistantAgentIntent;
  assistantMessage?: string;
  scope: {
    targetMode: AssistantAgentTargetMode;
    artifactIds: string[];
  };
  operations: Array<{
    kind: 'style_change' | 'content_edit' | 'structure_edit' | 'create' | 'export' | 'review' | 'search' | 'other';
    instruction: string;
  }>;
  requiresConfirmation: boolean;
  clarificationQuestion?: string;
  searchQuery?: string;
  localFilePaths?: AssistantAgentLocalFileRef[];
  sessionResourceIds?: string[];
  workspaceScan?: AssistantAgentWorkspaceScanRequest;
  networkRequests?: AssistantAgentNetworkRequest[];
  responseExperience?: AssistantResponseExperience;
  confidence: number;
  rationale?: string;
}

export interface AssistantAgentPatch {
  action: 'create' | 'update';
  artifactId?: string | null;
  kind: AssistantArtifactKind;
  title: string;
  summary?: string;
  language?: string | null;
  content: string;
  files?: AssistantArtifactFile[];
  baseVersionId?: string | null;
  changeSummary?: string;
  media?: AssistantArtifactMediaRef[];
  htmlRuntime?: AssistantHtmlRuntimeManifest;
  versionStage?: AssistantArtifactVersionStage;
  dataDescriptor?: AssistantArtifactDataDescriptor;
}

export interface AssistantAgentMediaTask {
  kind: 'image' | 'video';
  slotId?: string;
  prompt: string;
  altText: string;
  userCaption?: string;
  aspectRatio?: string;
  imageSize?: string;
  videoResolution?: string;
  videoDuration?: number;
  targetArtifactId?: string;
  targetImageIds?: string[];
  referenceImageIds?: string[];
  styleImageIds?: string[];
  referenceImages?: Array<{
    url: string;
    mimeType?: string;
    label?: string;
  }>;
}

export interface AssistantAgentPatchSet {
  assistantMessage: string;
  patches: AssistantAgentPatch[];
  mediaTasks?: AssistantAgentMediaTask[];
  dataOperations?: AssistantArtifactDataOperation[];
  dataResults?: AssistantArtifactDataResult[];
  versionOperations?: AssistantArtifactVersionOperation[];
  workspaceOperations?: Array<{
    directoryId: string;
    kind: 'write' | 'delete' | 'move' | 'copy';
    path: string;
    destinationPath?: string;
    content?: string;
    conflictPolicy?: 'rename' | 'skip' | 'overwrite';
    recursive?: boolean;
  }>;
}
