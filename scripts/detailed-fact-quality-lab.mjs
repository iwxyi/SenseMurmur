// Real-model regression for value, semantic repetition, provenance and updates.
// Uses synthetic dialogue only. Credentials are read from the existing test env.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const serviceUrl = new URL('../src/services/factualMemory.ts', import.meta.url);
const service = await readFile(serviceUrl, 'utf8');
const prompt = service.match(/export const FACT_EXTRACTION_PROMPT = `([\s\S]*?)`;/)?.[1];
if (!prompt) throw new Error('Cannot locate the production fact prompt');
const parserSource = await readFile(new URL('../src/services/factualMemoryTypes.ts', import.meta.url), 'utf8');
const { parseDetailedFacts } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(parserSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`);

const message = (id, content, speaker = '张飞') => ({ id, speaker, content });
const known = { ref: 'f0', title: '查账暗号', text: '刘备、关羽、张飞约定查账暗号为“风紧扯呼”：遇查时收起账本，不烧账；不得向外人透露。', status: 'agreed', sourceIds: ['old'] };
const fixtures = [
  { name: '重复保密', latest: '行行行——记心里，烂肚子里，往后不念了。', existing: [known], save: false },
  { name: '重复暗号', latest: '三弟，这暗号备记下了——风紧扯呼。不过你先别老念它，念顺了嘴，哪天在酒桌上说秃噜出去，就不用等人来查账了。', existing: [known], save: false },
  { name: '临场散场', latest: '谁也别多说，就这么定。三弟守城，我送人。', context: [message('prior', '明早城门送二哥一程，送完俺回营点粮。')], save: false },
  { name: '临时随行人手', latest: '人手上你甭客气——新野这边俺挑两个腿脚利索的跟你走，盘缠四十贯够了。', context: [message('prior', '明日关羽动身赴荆州。', '关羽')], save: false },
  { name: '送行后立即汇报', latest: '明早城门送完二哥，你回来先找我，把练兵头一笔怎么记当面说清楚。', context: [message('prior', '三弟应下送行后回来向刘备交代练兵头一笔账。', '刘备')], save: false },
  { name: '玩笑式请酒', latest: '明早城门见，谁迟了谁请酒！', save: false },
  { name: '临行泛泛关心', latest: '路上不对就捎信，别一个人硬扛。明早城门，我站那儿看你走。', context: [message('prior', '关羽明早赴荆州，刘备和张飞到城门送行。')], save: false },
  { name: '有明确后果的短期约定', latest: '上次信使晚了一天，援粮没赶上，营里断了两顿。明天你到荆州后每三天报一次平安；连续两次收不到信，我就按你遇险处理，立刻派人去找。', save: true, required: ['每三天', '两次', '派人'] },
  { name: '普通汤饭', latest: '二哥放心！俺这嗓门撑到明早都不带打弯的，汤保准烫嘴！', context: [message('prior', '三弟，那碗汤记着满的，别到时候自己先睡趴了。', '关羽')], save: false },
  { name: '临时取物', latest: '行，笔就在左边第二个抽屉，我顺手拿给你。', context: [message('prior', '签一下刚打印的表，谁手边有笔？', '同事')], save: false },
  { name: '泛泛关心', latest: '外面起风了，你回去路上慢点啊，到家早点歇着。', save: false },
  { name: '重要短期约定', latest: '明天下午两点你得陪我去签租约，我一个人拿不定主意。房东说过了两点就租给别人了，这次一定别忘。', save: true, required: ['两点', '租约'] },
  { name: '不显眼的边界', latest: '我不接没预约的电话，小时候总被家里突然打来的电话吓着。你找我先发条消息就好，这样我会安心点。', save: true, required: ['电话', '消息'] },
  { name: '新暗号', latest: '好，下次接头就用这个，别告诉外人。', context: [message('prior1', '下次接头定个暗号吧。', '关羽'), message('prior2', '风紧扯呼。')], save: true, required: ['风紧扯呼'], sources: ['prior1', 'prior2', 'new'] },
  { name: '个人新增条件', latest: '暗号只在东门查账时用；西门查账不要喊，交给我处理。', existing: [known], save: true, required: ['东门', '西门'], status: 'asserted', merge: false },
  { name: '共同更改条件', latest: '我们三人都同意了：暗号只在东门查账时用，西门不再使用。', existing: [known], save: true, required: ['东门', '西门'], status: 'agreed', merge: true },
  { name: '个人在意', latest: '这件旧外套是我妈最后给我缝的，上次送洗差点丢了，我心疼了一整晚。以后别帮我拿去洗。', save: true, required: ['外套', '洗'] },
  { name: '完整账目', latest: '把这份账记下，路上我得按这个数付：盘缠十五贯，草料九贯，关隘四贯，合二十八贯；礼数绢四匹、茶两担折十二贯，另列，不混。', save: true, required: ['十五贯', '九贯', '四贯', '二十八贯', '四匹', '两担', '十二贯'] },
];

const base = process.env.PNEUMATA_TEST_LLM_BASE_URL;
const key = process.env.PNEUMATA_TEST_LLM_API_KEY;
if (!base || !key) throw new Error('Set PNEUMATA_TEST_LLM_BASE_URL and PNEUMATA_TEST_LLM_API_KEY');
const model = process.env.PNEUMATA_TEST_LLM_MODEL || 'deepseek-v4-flash';
const variants = [{ name: 'current', prompt }];
const baselinePath = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice('--baseline='.length);
if (baselinePath) variants.unshift({ name: 'baseline', prompt: await readFile(resolve(baselinePath), 'utf8') });
const jobs = variants.flatMap((variant) => [0, 1].flatMap((repeat) => fixtures.map((fixture) => ({ variant, repeat, fixture }))));
const results = [];
async function worker() {
  while (jobs.length) {
    const { variant, repeat, fixture } = jobs.shift();
    const input = { newMessageId: 'new', newMessage: message('new', fixture.latest), contextMessages: fixture.context || [], existingFacts: fixture.existing || [] };
    const response = await fetch(`${base.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model, temperature: 0.8, max_tokens: 2000, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: `${variant.prompt}\nThe response must be exactly one valid JSON object. Do not wrap it in markdown.` }, { role: 'user', content: JSON.stringify(input) }] }),
    });
    if (!response.ok) throw new Error(`Model request failed: HTTP ${response.status}`);
    const payload = await response.json();
    const raw = payload.choices?.[0]?.message?.content || '';
    let facts = [], error;
    try {
      const allowed = new Set(['new', ...input.contextMessages.map((item) => item.id), ...input.existingFacts.flatMap((item) => item.sourceIds)]);
      const candidates = new Map(input.existingFacts.map((fact) => [fact.ref, { messageId: 'old', factIndex: 0, fact }]));
      facts = parseDetailedFacts(raw, allowed, 'new', undefined, candidates);
      if (Boolean(facts.length) !== fixture.save) throw new Error('Unexpected save/skip decision');
      const text = facts.map((fact) => fact.text).join('\n');
      if (fixture.required?.some((part) => !text.includes(part))) throw new Error('Missing required detail');
      if (fixture.status && facts.some((fact) => fact.status !== fixture.status)) throw new Error('Incorrect knowledge status');
      if (fixture.merge !== undefined && !facts.some((fact) => Boolean(fact.mergedFrom?.length) === fixture.merge)) throw new Error('Incorrect merge decision');
      if (fixture.sources?.some((id) => !facts.some((fact) => fact.sourceIds.includes(id)))) throw new Error('Missing evidence');
    } catch (failure) { error = failure.message; }
    const result = { variant: variant.name, repeat, name: fixture.name, passed: !error, error, facts, raw, finishReason: payload.choices?.[0]?.finish_reason, usage: payload.usage };
    results.push(result);
    console.log(JSON.stringify({ variant: result.variant, repeat, name: fixture.name, passed: result.passed, count: facts.length, error }));
  }
}
await Promise.all([worker(), worker(), worker()]);
const reportPath = process.argv.find((arg) => arg.startsWith('--report='))?.slice('--report='.length);
if (reportPath) await writeFile(resolve(reportPath), JSON.stringify({ model, temperature: 0.8, results }, null, 2));
const current = results.filter((result) => result.variant === 'current');
console.log(`Current prompt: ${current.filter((result) => result.passed).length}/${current.length} passed`);
if (current.some((result) => !result.passed)) process.exitCode = 1;
