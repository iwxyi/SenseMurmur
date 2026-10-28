import { unified } from 'unified';
import remarkParse from 'remark-parse';

const END_MARKER = '<!-- assistant-patch-set:end -->';
const parser = unified().use(remarkParse);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Resolve only content fields that the writer is allowed to supply. */
function resolveContents(manifest: unknown, blocks: Map<string, string>) {
  if (!isRecord(manifest)) throw new SyntaxError('Expected a patch set object');
  const used = new Set<string>();
  const resolve = (item: unknown) => {
    if (!isRecord(item) || !Object.hasOwn(item, 'contentRef')) return;
    const ref = item.contentRef;
    if (typeof ref !== 'string' || !blocks.has(ref) || Object.hasOwn(item, 'content')) {
      throw new SyntaxError('Invalid or ambiguous content reference');
    }
    item.content = blocks.get(ref);
    delete item.contentRef;
    used.add(ref);
  };
  if (Array.isArray(manifest.patches)) {
    for (const patch of manifest.patches) {
      resolve(patch);
      if (isRecord(patch) && Array.isArray(patch.files)) patch.files.forEach(resolve);
    }
  }
  if (Array.isArray(manifest.workspaceOperations)) manifest.workspaceOperations.forEach(resolve);
  if (used.size !== blocks.size) throw new SyntaxError('Unreferenced content block');
  return manifest;
}

export function parseAssistantAgentWriterOutput(raw: string, parseLegacyJson: (value: string) => unknown): unknown {
  const nodes = parser.parse(raw).children;
  const manifestNode = nodes[0];
  const isMultipart = nodes.some((node) => node.type === 'code' && node.lang === 'artifact-content')
    || nodes.some((node) => node.type === 'html' && node.value.trim() === END_MARKER)
    || (manifestNode?.type === 'code' && manifestNode.lang === 'json' && nodes.length > 1);
  if (!isMultipart) return resolveContents(parseLegacyJson(raw), new Map());

  const endNode = nodes[nodes.length - 1];
  // A missing closing fence consumes the end marker as code, so truncated
  // responses cannot be mistaken for complete files.
  if (manifestNode?.type !== 'code' || manifestNode.lang !== 'json'
    || endNode?.type !== 'html' || endNode.value.trim() !== END_MARKER) {
    throw new SyntaxError('Incomplete writer response');
  }
  const blocks = new Map<string, string>();
  for (const node of nodes.slice(1, -1)) {
    if (node.type !== 'code' || node.lang !== 'artifact-content'
      || !node.meta || !/^[a-zA-Z0-9_-]{1,80}$/.test(node.meta) || blocks.has(node.meta)) {
      throw new SyntaxError('Invalid or duplicate content block');
    }
    blocks.set(node.meta, node.value);
  }
  return resolveContents(JSON.parse(manifestNode.value), blocks);
}
