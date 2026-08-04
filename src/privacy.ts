const replacement = "[REDACTED]";

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s"']+/gi, `Authorization: Bearer ${replacement}`)
    .replace(/\b(BUTTONPROBE_API_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY|API_KEY|TOKEN|SECRET)\s*[:=]\s*[^\s"']+/gi, `$1=${replacement}`)
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, replacement)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement);
}
