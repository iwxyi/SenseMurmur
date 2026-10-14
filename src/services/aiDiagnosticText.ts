export function redactAiDiagnosticText(value: string, maxLength = 2_000) {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,"}]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["'])[^"']+/gi, '$1[REDACTED]')
    .replace(/data:image\/[\w.+-]+;base64,[a-z0-9+/=]+/gi, '[IMAGE_DATA_REDACTED]')
    .slice(0, maxLength);
}
