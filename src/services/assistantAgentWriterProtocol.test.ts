import { describe, expect, it } from 'vitest';
import { parseAssistantAgentWriterOutput } from './assistantAgentWriterProtocol';

function output(manifest: unknown, contents: Array<[string, string]>) {
  return [
    '```json', JSON.stringify(manifest), '```',
    ...contents.flatMap(([id, content]) => [`~~~~~artifact-content ${id}`, content, '~~~~~']),
    '<!-- assistant-patch-set:end -->',
  ].join('\n');
}

describe('assistant writer content transport', () => {
  it('preserves source quotes, escapes, indentation and embedded Markdown fences', () => {
    const content = [
      'const pattern = /\\w+\\s+"quoted"/g;',
      'const path = "C:\\\\temp\\\\file.txt";',
      'const example = `', '```json', '{"answer":42}', '```', '~~~~', '`;',
      'function greeting() {', '  return "你好";', '}',
    ].join('\n');
    const parsed = parseAssistantAgentWriterOutput(output({
      patches: [{ contentRef: 'main' }],
    }, [['main', content]]), JSON.parse);
    expect(parsed).toEqual({ patches: [{ content }] });
  });

  it('resolves multiple files and workspace writes without confusing their contents', () => {
    expect(parseAssistantAgentWriterOutput(output({
      patches: [{ files: [{ path: 'main.js', contentRef: 'script' }, { path: 'index.html', contentRef: 'page' }] }],
      workspaceOperations: [{ kind: 'write', path: 'README.md', contentRef: 'readme' }],
    }, [['script', 'console.log("hello");'], ['page', '<h1>Hello</h1>'], ['readme', '# Hello']]), JSON.parse)).toEqual({
      patches: [{ files: [{ path: 'main.js', content: 'console.log("hello");' }, { path: 'index.html', content: '<h1>Hello</h1>' }] }],
      workspaceOperations: [{ kind: 'write', path: 'README.md', content: '# Hello' }],
    });
  });

  it('accepts legacy JSON and metadata-only results', () => {
    const manifest = { assistantMessage: '没有变更', patches: [] };
    expect(parseAssistantAgentWriterOutput(JSON.stringify(manifest), JSON.parse)).toEqual(manifest);
    expect(parseAssistantAgentWriterOutput(output(manifest, []), JSON.parse)).toEqual(manifest);
  });

  it.each([
    ['missing end marker', output({ patches: [{ contentRef: 'main' }] }, [['main', 'complete']]).replace('<!-- assistant-patch-set:end -->', '')],
    ['unclosed content fence', output({ patches: [{ contentRef: 'main' }] }, [['main', 'partial']]).replace('\n~~~~~\n<!--', '\n<!--')],
    ['missing file', output({ patches: [{ contentRef: 'missing' }] }, [])],
    ['duplicate file', output({ patches: [{ contentRef: 'main' }] }, [['main', 'one'], ['main', 'two']])],
    ['unreferenced file', output({ patches: [] }, [['main', 'unused']])],
    ['ambiguous content', output({ patches: [{ content: 'one', contentRef: 'main' }] }, [['main', 'two']])],
    ['unresolved legacy reference', JSON.stringify({ patches: [{ contentRef: 'missing' }] })],
  ])('rejects %s instead of saving partial source', (_name, raw) => {
    expect(() => parseAssistantAgentWriterOutput(raw, JSON.parse)).toThrow();
  });
});
