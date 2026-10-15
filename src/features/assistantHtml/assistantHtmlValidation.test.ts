import { describe, expect, it } from 'vitest';
import { buildAssistantHtmlDocument } from './assistantHtmlDocument';
import { normalizeAssistantHtmlRuntime, validateAssistantHtmlPayload } from './assistantHtmlValidation';
import { parseAssistantHtmlBridgeEvent } from './assistantHtmlBridge';

const manifest = normalizeAssistantHtmlRuntime({
  submission: {
    interactionId: 'exam-1',
    label: '交卷',
    resultType: 'quiz',
    fields: [
      { name: 'answer', type: 'single_choice', required: true, options: ['A', 'B'] },
      { name: 'note', type: 'textarea', maxLength: 20 },
    ],
  },
}, '<form><input name="answer"></form>')!;

describe('assistant HTML safety', () => {
  it('promotes large structured inputs to full pages', () => {
    const largeMarkup = normalizeAssistantHtmlRuntime({}, `<section>${'x'.repeat(12_001)}</section>`, 'inline_interaction');
    const manyFields = normalizeAssistantHtmlRuntime({ submission: {
      interactionId: 'large-form', fields: Array.from({ length: 13 }, (_, index) => ({ name: `field${index}`, type: 'text' })),
    } }, '<form></form>', 'inline_interaction');
    expect(largeMarkup?.presentation).toBe('fullscreen');
    expect(manyFields?.presentation).toBe('fullscreen');
  });
  it('keeps structured input inline even when the writer returns a full document', () => {
    const manifest = normalizeAssistantHtmlRuntime({
      submission: {
        interactionId: 'vote-1',
        resultType: 'selection',
        fields: [{ name: 'choice', type: 'single_choice', required: true, options: ['A', 'B'] }],
      },
    }, '<!doctype html><html><body><form><input name="choice" /></form></body></html>', 'inline_interaction');
    expect(manifest?.presentation).toBe('inline');
  });
  it('preserves normal browser markup while installing the runtime bridge', () => {
    const document = buildAssistantHtmlDocument({
      html: '<html><head><style>@import "https://bad.test/a.css";</style><script>steal()</script></head><body><iframe src="https://bad.test"></iframe><button onclick="steal()">提交</button></body></html>',
      manifest,
      channelToken: 'token-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
    });

    expect(document).toContain('steal()');
    expect(document).toContain('<iframe');
    expect(document).toContain('@import "https://bad.test/a.css"');
    expect(document).toContain('<script>');
    expect(document).toContain("parent.postMessage");
    expect(document).toContain("action==='submit'");
  });

  it('keeps authored controls usable while preventing bridge writes in a historical read-only version', () => {
    const document = buildAssistantHtmlDocument({
      html: '<form><input name="answer"><button data-pneumata-action="submit">提交</button></form>',
      manifest,
      channelToken: 'token-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      readOnly: true,
    });

    expect(document).toContain('"readOnly":true');
    expect(document).not.toContain("node.disabled=true");
    expect(document).toContain('if(config.readOnly||!config.fields.length)return');
  });

  it('validates and normalizes declared submission fields', () => {
    expect(validateAssistantHtmlPayload(manifest, { answer: 'A', note: '复习第一章' })).toEqual({ answer: 'A', note: '复习第一章' });
    expect(() => validateAssistantHtmlPayload(manifest, { answer: 'C', note: '' })).toThrow('无效选项');
    expect(() => validateAssistantHtmlPayload(manifest, { answer: 'A', unknown: 'x' })).toThrow('未知字段');
  });

  it('derives presentation from content shape instead of trusting model parameters', () => {
    const fragment = normalizeAssistantHtmlRuntime({ ...manifest, presentation: 'fullscreen', viewport: { preferredHeight: 999 } }, '<div>轻量选择</div>');
    const page = normalizeAssistantHtmlRuntime({ ...manifest, presentation: 'inline' }, '<!doctype html><html><body>完整试卷</body></html>');

    expect(fragment?.presentation).toBe('inline');
    expect(fragment?.viewport).toEqual({ preferredHeight: 280, maxInlineHeight: 480 });
    expect(page?.presentation).toBe('fullscreen');
  });

  it('accepts bridge messages only from the bound frame and interaction channel', () => {
    const frameWindow = {} as Window;
    const validData = {
      type: 'submit',
      channelToken: 'token-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      interactionId: 'exam-1',
      payload: { answer: 'A' },
    };
    const parse = (data: Record<string, unknown>, source: MessageEventSource | null = frameWindow) => parseAssistantHtmlBridgeEvent({
      event: { data, source } as MessageEvent,
      frameWindow,
      channelToken: 'token-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      interactionId: 'exam-1',
    });

    expect(parse(validData)?.type).toBe('submit');
    expect(parse({ ...validData, closeOnSubmit: false })?.closeOnSubmit).toBe(false);
    expect(parse({ ...validData, closeOnSubmit: true })?.closeOnSubmit).toBe(true);
    expect(parse({ ...validData, closeOnSubmit: 'false' })).toBeNull();
    expect(parse({ ...validData, channelToken: 'wrong' })).toBeNull();
    expect(parse({ ...validData, versionId: 'other-version' })).toBeNull();
    expect(parse(validData, {} as Window)).toBeNull();
  });
});
