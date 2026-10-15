import type { AssistantHtmlRuntimeManifest } from '../../types/assistantArtifact';
import { sanitizeUserFacingText } from '../../services/displayTextSanitizer';
import { validateAssistantHtmlPayload } from './assistantHtmlValidation';

export function formatAssistantHtmlSubmission(title: string, manifest: AssistantHtmlRuntimeManifest, input: unknown) {
  const payload = validateAssistantHtmlPayload(manifest, input);
  const clean = (value: string) => sanitizeUserFacingText(value, [], { preserveLineBreaks: true });
  const fields = manifest.submission!.fields.map((field, index) => {
    const value = payload[field.name];
    const text = typeof value === 'boolean' ? (value ? '是' : '否')
      : Array.isArray(value) ? value.join('、')
        : value == null || value === '' ? '未填写' : String(value);
    return `${clean(field.label || '') || `第 ${index + 1} 项`}：${clean(text)}`;
  });
  return [`已提交「${clean(title)}」：`, ...fields].join('\n');
}
