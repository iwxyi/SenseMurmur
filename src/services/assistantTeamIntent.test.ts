import { describe, expect, it } from 'vitest';
import { parseAssistantTaskRoute } from './assistantTeamIntent';

describe('assistant team intent', () => {
  it('accepts only explicit routing decisions', () => {
    expect(parseAssistantTaskRoute('{"route":"reply"}')).toEqual({ route: 'reply' });
    expect(parseAssistantTaskRoute('{"route":"team","goal":"完成短片"}')).toEqual({ route: 'team', goal: '完成短片' });
    expect(() => parseAssistantTaskRoute('team')).toThrow('格式');
    expect(() => parseAssistantTaskRoute('{"route":"team"}')).toThrow('目标');
    expect(() => parseAssistantTaskRoute('{"route":"unknown"}')).toThrow('执行方式');
  });
});
