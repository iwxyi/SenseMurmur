export function redactAiDiagnosticText(value: string, maxLength = 2_000) {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,"}]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["'])[^"']+/gi, '$1[REDACTED]')
    .replace(/data:image\/[\w.+-]+;base64,[a-z0-9+/=]+/gi, '[IMAGE_DATA_REDACTED]')
    .slice(0, maxLength);
}

export function redactAiDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAiDiagnosticValue);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactAiDiagnosticText(value) : value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|prompt|messages|content|requestBody|request_body)$/i.test(key)
      ? '[REDACTED]' : redactAiDiagnosticValue(entry),
  ]));
}
