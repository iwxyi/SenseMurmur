type AceRequestDiagnostic = {
  model?: unknown;
  endpoint?: unknown;
  requestId?: unknown;
  fields?: unknown;
  values?: unknown;
  promptCharacters?: unknown;
  promptUtf8Bytes?: unknown;
  promptMaxLength?: unknown;
  imageCount?: unknown;
  allowedValues?: unknown;
  durationConstraints?: unknown;
  parameters?: unknown;
  contentTypes?: unknown;
};

const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const safePath = /^\/(?:[A-Za-z0-9_.-]+\/?)*$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function formatValue(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9:._-]{1,40}$/.test(value)
    || typeof value === 'number' && Number.isFinite(value)
    || typeof value === 'boolean' ? String(value) : undefined;
}

export function formatAceMediaFailure(reason: string, rawDiagnostic: unknown) {
  const diagnostic = rawDiagnostic as AceRequestDiagnostic | undefined;
  if (!diagnostic || typeof diagnostic !== 'object') return reason;
  const details: string[] = [];
  if (typeof diagnostic.model === 'string' && safeIdentifier.test(diagnostic.model)) details.push(`模型 ${diagnostic.model}`);
  const endpoint = typeof diagnostic.endpoint === 'string' ? diagnostic.endpoint.match(/^(GET|POST) (\/.+)$/) : null;
  if (endpoint && safePath.test(endpoint[2])) details.push(`接口 ${endpoint[1]} ${endpoint[2]}`);
  const fields = Array.isArray(diagnostic.fields)
    ? diagnostic.fields.filter((value): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(value)).slice(0, 24)
    : [];
  if (fields.length) details.push(`实际参数 ${fields.join(', ')}`);
  if (Array.isArray(diagnostic.contentTypes)) {
    const contentTypes = diagnostic.contentTypes.slice(0, 12).map((entry) => {
      const item = record(entry);
      if (typeof item.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(item.type)) return undefined;
      const role = typeof item.role === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(item.role) ? `(${item.role})` : '';
      return `${item.type}${role}`;
    }).filter((value): value is string => Boolean(value));
    if (contentTypes.length) details.push(`内容类型 ${contentTypes.join('/')}`);
  }
  const values = record(diagnostic.values);
  const friendlyNames: Record<string, string> = { ratio: '比例', aspect_ratio: '比例', resolution: '分辨率', duration: '时长', async: '异步' };
  for (const key of ['ratio', 'aspect_ratio', 'resolution', 'duration', 'async']) {
    const value = formatValue(values[key]);
    if (value) details.push(`${friendlyNames[key]} ${value}${key === 'duration' ? ' 秒' : ''}`);
  }
  if (Array.isArray(diagnostic.parameters)) {
    for (const rawParameter of diagnostic.parameters.slice(0, 24)) {
      const parameter = record(rawParameter);
      if (typeof parameter.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(parameter.name)
        || ['ratio', 'aspect_ratio', 'resolution', 'duration', 'async'].includes(parameter.name)) continue;
      const value = formatValue(parameter.value);
      if (!value) continue;
      const allowedValues = Array.isArray(parameter.allowedValues)
        ? parameter.allowedValues.filter((item): item is string => typeof item === 'string' && /^[A-Za-z0-9:._-]{1,40}$/.test(item)).slice(0, 12)
        : [];
      const range = typeof parameter.minimum === 'number' && typeof parameter.maximum === 'number'
        ? `，允许范围 ${parameter.minimum}-${parameter.maximum}` : '';
      const choices = allowedValues.length ? `，允许值 ${allowedValues.join('/')}` : '';
      const defaultValue = formatValue(parameter.defaultValue);
      const defaultText = defaultValue !== undefined ? `，模型默认 ${defaultValue}` : '';
      details.push(`${parameter.name}=${value}${range}${choices}${defaultText}`);
    }
  }
  if (Number.isInteger(diagnostic.promptCharacters) && Number(diagnostic.promptCharacters) >= 0) {
    const limit = Number.isInteger(diagnostic.promptMaxLength) && Number(diagnostic.promptMaxLength) > 0
      ? `，模型上限 ${diagnostic.promptMaxLength} 字符` : '';
    const bytes = Number.isInteger(diagnostic.promptUtf8Bytes) && Number(diagnostic.promptUtf8Bytes) >= 0
      ? `，UTF-8 ${diagnostic.promptUtf8Bytes} 字节` : '';
    details.push(`提示词 ${diagnostic.promptCharacters} 字符${limit}${bytes}`);
  }
  if (Number.isInteger(diagnostic.imageCount) && Number(diagnostic.imageCount) >= 0) details.push(`参考图 ${diagnostic.imageCount} 张`);
  const allowed = record(diagnostic.allowedValues);
  for (const key of ['ratio', 'aspect_ratio', 'resolution']) {
    const choices = allowed[key];
    if (Array.isArray(choices)) {
      const safeChoices = choices.filter((value): value is string => typeof value === 'string' && /^[A-Za-z0-9:._-]{1,40}$/.test(value)).slice(0, 12);
      if (safeChoices.length) details.push(`${friendlyNames[key]}可选值 ${safeChoices.join('/')}`);
    }
  }
  const duration = record(diagnostic.durationConstraints);
  if (typeof duration.minimum === 'number' && typeof duration.maximum === 'number') {
    details.push(`模型时长范围 ${duration.minimum}-${duration.maximum} 秒`);
  }
  if (typeof diagnostic.requestId === 'string' && /^[a-f0-9]{12}$/.test(diagnostic.requestId)) details.push(`请求标识 ${diagnostic.requestId}`);
  return details.length ? `${reason}。请求诊断：${details.join('；')}。` : reason;
}
