import { deflateRawSync, inflateRawSync } from "node:zlib";

import { caseResults, type CaseResult } from "@spark-x-test/contracts";

export type ResultSummary = Readonly<Record<CaseResult, number>>;

export function summarizeResults(results: readonly CaseResult[]): ResultSummary {
  const summary = Object.fromEntries(caseResults.map((result) => [result, 0])) as Record<
    CaseResult,
    number
  >;
  for (const result of results) {
    summary[result] += 1;
  }
  return summary;
}

const sensitiveKeyPattern =
  /authorization|proxy-authorization|cookie|set-cookie|password|passwd|token|secret|api[-_]?key/i;
const utf8Flag = 0x0800;
const localFileHeaderSignature = 0x04034b50;
const centralDirectorySignature = 0x02014b50;
const endOfCentralDirectorySignature = 0x06054b50;

export function secretRedactionVariants(secrets: readonly string[]): readonly string[] {
  return [
    ...new Set(
      secrets
        .filter((secret) => secret.length > 0)
        .flatMap((secret) => [
          secret,
          encodeURIComponent(secret),
          Buffer.from(secret).toString("base64"),
        ]),
    ),
  ].sort((left, right) => right.length - left.length);
}

export function redactText(value: string, secrets: readonly string[]): string {
  return secretRedactionVariants(secrets).reduce(
    (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
    value,
  );
}

export function redactEvidence(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 30) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => redactEvidence(item, secrets, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[REDACTED]" : redactEvidence(item, secrets, depth + 1),
      ]),
    );
  }
  return value;
}

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === endOfCentralDirectorySignature) return offset;
  }
  throw new Error("TRACE_ARCHIVE_INVALID");
}

function readZipEntries(archive: Buffer): readonly ZipEntry[] {
  const endOffset = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (entryCount > 10_000 || centralOffset >= archive.length) {
    throw new Error("TRACE_ARCHIVE_LIMIT_EXCEEDED");
  }
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== centralDirectorySignature) {
      throw new Error("TRACE_ARCHIVE_INVALID");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const compression = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    if ((flags & 0x0001) !== 0 || ![0, 8].includes(compression)) {
      throw new Error("TRACE_ARCHIVE_UNSUPPORTED");
    }
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString((flags & utf8Flag) === 0 ? "latin1" : "utf8");
    if (name.includes("\0") || name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error("TRACE_ARCHIVE_UNSAFE_PATH");
    }
    if (archive.readUInt32LE(localOffset) !== localFileHeaderSignature) {
      throw new Error("TRACE_ARCHIVE_INVALID");
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const data = compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    if (data.length !== uncompressedSize) throw new Error("TRACE_ARCHIVE_INVALID");
    totalSize += data.length;
    if (totalSize > 100 * 1024 * 1024) throw new Error("TRACE_ARCHIVE_LIMIT_EXCEEDED");
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

let crcTable: Uint32Array | undefined;

function crc32(data: Buffer): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_value, index) => {
    let current = index;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    return current >>> 0;
  });
  let current = 0xffffffff;
  for (const byte of data)
    current = (crcTable[(current ^ byte) & 0xff] as number) ^ (current >>> 8);
  return (current ^ 0xffffffff) >>> 0;
}

function writeZipEntries(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(localFileHeaderSignature, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8Flag, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(centralDirectorySignature, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8Flag, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(endOfCentralDirectorySignature, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function sanitizeTraceText(data: Buffer, secrets: readonly string[]): Buffer {
  const sanitized = data
    .toString("utf8")
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      try {
        return JSON.stringify(redactEvidence(JSON.parse(line) as unknown, secrets));
      } catch {
        return redactText(line, secrets);
      }
    })
    .join("\n");
  return Buffer.from(sanitized, "utf8");
}

export function sanitizePlaywrightTraceArchive(
  archive: Uint8Array,
  secrets: readonly string[],
): Buffer {
  const source = Buffer.from(archive);
  if (source.length > 50 * 1024 * 1024) throw new Error("TRACE_ARCHIVE_LIMIT_EXCEEDED");
  const entries = readZipEntries(source)
    .filter((entry) => !entry.name.startsWith("resources/"))
    .map((entry) => ({
      name: entry.name,
      data: entry.name.endsWith("/") ? entry.data : sanitizeTraceText(entry.data, secrets),
    }));
  if (!entries.some((entry) => entry.name.endsWith(".trace") || entry.name === "trace.trace")) {
    throw new Error("TRACE_ARCHIVE_CONTENT_MISSING");
  }
  const variants = secretRedactionVariants(secrets).map((secret) => Buffer.from(secret));
  for (const entry of entries) {
    if (variants.some((secret) => entry.data.includes(secret))) {
      throw new Error("TRACE_REDACTION_FAILED");
    }
  }
  return writeZipEntries(entries);
}
