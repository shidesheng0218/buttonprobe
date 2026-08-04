import { describe, expect, test } from "vitest";
import { classifyDangerousControl } from "../src/danger.js";

describe("classifyDangerousControl", () => {
  test("skips destructive and account-changing controls", () => {
    expect(classifyDangerousControl({ text: "Delete project", type: "button" })).toBe("delete");
    expect(classifyDangerousControl({ text: "Pay now", type: "submit" })).toBe("payment");
    expect(classifyDangerousControl({ text: "Log out", type: "button" })).toBe("account");
  });

  test("allows ordinary local UI controls", () => {
    expect(classifyDangerousControl({ text: "Open settings", type: "button" })).toBeNull();
    expect(classifyDangerousControl({ text: "Preview release", type: "button" })).toBeNull();
  });

  test("still skips explicit production release actions", () => {
    expect(classifyDangerousControl({ text: "Release to production", type: "button" })).toBe("publish");
  });
});
