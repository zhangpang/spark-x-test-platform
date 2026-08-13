import type { AdapterManifest } from "@spark-x-test/adapter-sdk";

export const sparkXAgentAdapterManifest: AdapterManifest = {
  manifestVersion: "1.0",
  key: "spark-x-agent",
  name: "星火 Agent",
  version: "0.1.0",
  protocolVersion: "1.0",
  platformRange: ">=0.1.0 <0.2.0",
  environmentSchema: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl"],
    properties: { baseUrl: { type: "string", format: "uri" } },
  },
  capabilities: {
    actions: [],
    assertions: [],
    fixtures: [],
    telemetry: [],
  },
};

export const sparkXAgentAdapterPhase = "manifest-only" as const;
