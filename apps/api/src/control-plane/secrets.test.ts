import { createDecipheriv } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ControlPlaneError } from "./errors.js";
import { SecretVault } from "./secrets.js";

describe("SecretVault", () => {
  it("fails closed when no encryption key is configured", () => {
    expect(() => new SecretVault().encrypt("plain-value")).toThrowError(ControlPlaneError);
  });

  it("encrypts values with AES-256-GCM without retaining plaintext", () => {
    const key = Buffer.alloc(32, 7);
    const encrypted = new SecretVault(key.toString("base64")).encrypt("sensitive-value");
    expect(Buffer.from(encrypted.ciphertext).toString("utf8")).not.toContain("sensitive-value");

    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(encrypted.initializationVector),
    );
    decipher.setAuthTag(Buffer.from(encrypted.authenticationTag));
    const recovered = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
    expect(recovered).toBe("sensitive-value");
  });
});
