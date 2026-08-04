export interface DangerousControlInput {
  text: string;
  type: string;
}

const patterns: Array<{ reason: string; expression: RegExp }> = [
  { reason: "delete", expression: /\b(delete|remove|destroy|erase|drop)\b/i },
  { reason: "payment", expression: /\b(pay|purchase|buy|checkout|subscribe|charge)\b/i },
  { reason: "account", expression: /\b(log\s*out|sign\s*out|deactivate|disable account)\b/i },
  {
    reason: "publish",
    expression: /\b(publish|deploy|send|invite|submit form)\b|\brelease\s+(?:now|to|into)\b/i
  }
];

export function classifyDangerousControl(input: DangerousControlInput): string | null {
  const value = `${input.text} ${input.type}`.trim();
  for (const pattern of patterns) {
    if (pattern.expression.test(value)) return pattern.reason;
  }
  return null;
}
