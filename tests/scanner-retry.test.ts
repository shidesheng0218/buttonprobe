import { expect, test, vi } from "vitest";
import { retryTransientPageRead } from "../src/scanner.js";

test("retries a page read once after a navigation destroys the execution context", async () => {
  const operation = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error("Execution context was destroyed, most likely because of a navigation"))
    .mockResolvedValueOnce("stable");
  const onRetry = vi.fn(async () => undefined);

  await expect(retryTransientPageRead(operation, onRetry)).resolves.toBe("stable");
  expect(operation).toHaveBeenCalledTimes(2);
  expect(onRetry).toHaveBeenCalledOnce();
});

test("does not retry unrelated browser errors", async () => {
  const operation = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("Selector is invalid"));

  await expect(retryTransientPageRead(operation)).rejects.toThrow("Selector is invalid");
  expect(operation).toHaveBeenCalledOnce();
});
