import Ajv, { type ValidateFunction } from 'ajv';

export type TeamJsonSchema = boolean | Record<string, unknown>;

const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'anyOf', 'allOf', 'oneOf', 'not', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'title', 'description']);
const validators = new Map<string, ValidateFunction>();

// This local draft-07 profile excludes references, regexes and custom code from model-authored schemas.
export function parseTeamJsonSchema(raw: unknown): TeamJsonSchema {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(raw); } catch { throw new Error('JSON 字段契约必须是可保存的 JSON'); }
  if (!serialized || serialized.length > 16_000) throw new Error('JSON 字段契约过大或无效');
  let count = 0;
  function visit(value: unknown, depth: number) {
    if (depth > 12 || ++count > 256) throw new Error('JSON 字段契约结构过于复杂');
    if (typeof value === 'boolean') return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 字段契约须为对象或布尔值');
    const node = value as Record<string, unknown>;
    if (Object.keys(node).some((key) => !KEYWORDS.has(key))) throw new Error('JSON 字段契约包含不支持的关键字');
    if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
      for (const child of Object.values(node.properties)) visit(child, depth + 1);
    }
    for (const key of ['items', 'additionalProperties', 'not']) if (node[key] !== undefined) visit(node[key], depth + 1);
    for (const key of ['anyOf', 'allOf', 'oneOf']) {
      if (Array.isArray(node[key])) for (const child of node[key]) visit(child, depth + 1);
    }
  }
  const schema: unknown = JSON.parse(serialized);
  visit(schema, 0);
  validatorFor(schema as TeamJsonSchema);
  return schema as TeamJsonSchema;
}

function validatorFor(schema: TeamJsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  const saved = validators.get(key);
  if (saved) return saved;
  const ajv = new Ajv({ allErrors: false, strict: true, strictRequired: false, allowUnionTypes: true,
    ownProperties: true, validateFormats: false, messages: false, logger: false });
  let validate: ValidateFunction;
  try { validate = ajv.compile(schema); }
  catch { throw new Error('JSON 字段契约无效，请检查类型、字段与约束'); }
  if (validators.size >= 32) validators.delete(validators.keys().next().value!);
  validators.set(key, validate);
  return validate;
}

export function matchesTeamJsonSchema(schema: TeamJsonSchema, value: unknown): boolean {
  return validatorFor(parseTeamJsonSchema(schema))(value) === true;
}
