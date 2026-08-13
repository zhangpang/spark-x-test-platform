import { createCipheriv, randomBytes } from "node:crypto";

import { ControlPlaneError } from "./errors.js";
import type { EncryptedSecret } from "./model.js";

export class SecretVault {
  readonly #key?: Buffer;

  constructor(encodedKey?: string) {
    if (encodedKey === undefined || encodedKey.trim() === "") return;
    const decoded = Buffer.from(encodedKey, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== encodedKey.trim()) {
      throw new Error(
        "PLATFORM_SECRET_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key",
      );
    }
    this.#key = decoded;
  }

  encrypt(value: string): EncryptedSecret {
    if (this.#key === undefined) {
      throw new ControlPlaneError(
        "SECRET_VAULT_UNAVAILABLE",
        "平台密钥库尚未配置，不能保存密钥。",
        503,
      );
    }
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, initializationVector);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      ciphertext,
      initializationVector,
      authenticationTag: cipher.getAuthTag(),
    };
  }
}
