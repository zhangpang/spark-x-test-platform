import { describe, expect, it, vi } from "vitest";

import { createIdempotencyKey } from "./idempotency.js";

describe("browser idempotency keys", () => {
  it("uses native randomUUID when the browser exposes it", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes);

    expect(
      createIdempotencyKey({
        randomUUID: () => "00000000-0000-4000-8000-000000000001",
        getRandomValues,
      }),
    ).toBe("00000000-0000-4000-8000-000000000001");
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("builds an RFC 4122 v4 key from getRandomValues on an insecure HTTP origin", () => {
    const key = createIdempotencyKey({
      getRandomValues(bytes) {
        bytes.forEach((_value, index) => {
          bytes[index] = index;
        });
        return bytes;
      },
    });

    expect(key).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });
});
