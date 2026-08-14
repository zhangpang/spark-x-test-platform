import { describe, expect, it } from "vitest";

import { deflateRawSync } from "node:zlib";

import { redactEvidence, sanitizePlaywrightTraceArchive, summarizeResults } from "./index.js";

describe("result summary", () => {
  it("does not merge environment and product failures", () => {
    const summary = summarizeResults(["product_failed", "environment_failed", "passed"]);
    expect(summary.product_failed).toBe(1);
    expect(summary.environment_failed).toBe(1);
    expect(summary.passed).toBe(1);
  });
});

function crc32(data: Buffer): number {
  let current = 0xffffffff;
  for (const byte of data) {
    current ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
  }
  return (current ^ 0xffffffff) >>> 0;
}

function traceArchive(entries: readonly Readonly<{ name: string; data: string }>[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

describe("evidence redaction", () => {
  it("redacts secret values and sensitive keys recursively", () => {
    expect(
      redactEvidence(
        { headers: { authorization: "Bearer secret-value" }, body: "echo:secret-value" },
        ["secret-value"],
      ),
    ).toEqual({ headers: { authorization: "[REDACTED]" }, body: "echo:[REDACTED]" });
  });

  it("removes trace resource bodies and redacts structured trace events", () => {
    const secret = "synthetic-secret";
    const sanitized = sanitizePlaywrightTraceArchive(
      traceArchive([
        {
          name: "trace.trace",
          data: `${JSON.stringify({ type: "action", token: secret, url: `/login?key=${secret}` })}\n`,
        },
        { name: "resources/body.txt", data: secret },
      ]),
      [secret],
    );

    expect(sanitized.includes(Buffer.from(secret))).toBe(false);
    expect(sanitized.includes(Buffer.from("resources/body.txt"))).toBe(false);
    expect(sanitized.includes(Buffer.from("trace.trace"))).toBe(true);
  });
});
