import { expect, test } from "vitest";
import { redactSensitiveText } from "../src/privacy.js";

test("redacts credentials, bearer tokens, and email addresses before model upload", () => {
  const input = [
    "Authorization: Bearer abc.def.ghi",
    "OPENAI_API_KEY=sk-secret-value",
    "token: ghp_1234567890abcdefghijklmnop",
    "owner@example.com"
  ].join("\n");

  const result = redactSensitiveText(input);

  expect(result).not.toContain("abc.def.ghi");
  expect(result).not.toContain("sk-secret-value");
  expect(result).not.toContain("ghp_1234567890abcdefghijklmnop");
  expect(result).not.toContain("owner@example.com");
  expect(result).toContain("[REDACTED]");
});
