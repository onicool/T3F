// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";

import { type SelfInvocation, selfInvocationArgs } from "./nodeRuntime.ts";

export type AcpMcpBridgeBackend = "node" | "rust";
export type AcpMcpBridgeBackendMode = "auto" | "node" | "rust";

export const ACP_MCP_BRIDGE_BACKEND_ENV = "T3F_BRIDGE_BACKEND";
export const ACP_MCP_BRIDGE_BIN_ENV = "T3_RUST_BRIDGE_BIN";
export const ACP_MCP_BRIDGE_GUARD_BLOCK_ENV = "T3F_BRIDGE_GUARD_BLOCK";

/** Versions of the Rust bridge whose `--version` output the selector accepts. */
export const SUPPORTED_RUST_BRIDGE_VERSIONS: ReadonlyArray<string> = ["0.1.0"];

export interface AcpMcpInvocation {
  readonly backend: AcpMcpBridgeBackend;
  /** Set only when a pre-flight check failed in `auto` mode and Node took over. */
  readonly fallbackReason?: string;
}

export interface AcpMcpBridgeDiagnostic {
  readonly mode: AcpMcpBridgeBackendMode;
  readonly backend: AcpMcpBridgeBackend;
  readonly reason: string;
  readonly binaryPath?: string;
  readonly binaryVersion?: string;
  readonly binarySha256?: string;
}

export interface RustBridgeProbe {
  readonly stat: (path: string) => { readonly isFile: boolean; readonly executable: boolean } | undefined;
  readonly version: (path: string) => string | undefined;
  readonly sha256: (path: string) => string | undefined;
}

const defaultProbe: RustBridgeProbe = {
  stat: (path) => {
    try {
      const stats = NodeFs.statSync(path);
      return { isFile: stats.isFile(), executable: (stats.mode & 0o111) !== 0 };
    } catch {
      return undefined;
    }
  },
  version: (path) => {
    try {
      const result = NodeChildProcess.spawnSync(path, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
      // The bridge prints `<name> <version>`; the version is the last token.
      return result.stdout.trim().split(/\s+/).at(-1);
    } catch {
      return undefined;
    }
  },
  sha256: (path) => {
    try {
      return NodeCrypto.createHash("sha256").update(NodeFs.readFileSync(path)).digest("hex");
    } catch {
      return undefined;
    }
  },
};

export interface ResolveAcpMcpInvocationInput {
  readonly self: SelfInvocation;
  readonly endpoint: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly probe?: RustBridgeProbe;
  readonly recordDiagnostic?: (diagnostic: AcpMcpBridgeDiagnostic) => void;
}

export class AcpMcpBridgeUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Rust ACP MCP bridge is unavailable: ${reason}`);
    this.name = "AcpMcpBridgeUnavailableError";
    this.reason = reason;
  }
}

const verifiedBinaries = new Map<string, { readonly version: string; readonly sha256: string }>();

/** Test hook: pre-flight verification is cached per binary path, as repeat checks are wasteful. */
export const clearAcpMcpBridgeVerificationCache = (): void => {
  verifiedBinaries.clear();
};

const defaultRecordDiagnostic = (diagnostic: AcpMcpBridgeDiagnostic): void => {
  // The server log is the local diagnostic sink; MCP stdout stays protocol-only.
  process.stderr.write(
    `[t3f-bridge] ${JSON.stringify({ at: new Date().toISOString(), ...diagnostic })}\n`,
  );
};

const isLoopbackHttpEndpoint = (endpoint: string): boolean => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
};

type RustBridgeCheck =
  | { readonly ok: true; readonly version: string; readonly sha256: string }
  | { readonly ok: false; readonly reason: string };

const checkRustBridge = (binaryPath: string, probe: RustBridgeProbe): RustBridgeCheck => {
  const cached = verifiedBinaries.get(binaryPath);
  if (cached !== undefined) return { ok: true, ...cached };
  const stat = probe.stat(binaryPath);
  if (stat === undefined) return { ok: false, reason: "binary-not-found" };
  if (!stat.isFile) return { ok: false, reason: "binary-not-a-file" };
  if (!stat.executable) return { ok: false, reason: "binary-not-executable" };
  const version = probe.version(binaryPath);
  if (version === undefined) return { ok: false, reason: "version-check-failed" };
  if (!SUPPORTED_RUST_BRIDGE_VERSIONS.includes(version)) {
    return { ok: false, reason: `unsupported-version:${version}` };
  }
  const sha256 = probe.sha256(binaryPath);
  if (sha256 === undefined) return { ok: false, reason: "sha256-failed" };
  verifiedBinaries.set(binaryPath, { version, sha256 });
  return { ok: true, version, sha256 };
};

/**
 * The one place that decides whether ACP MCP traffic runs through the Node
 * fast path or the Rust bridge. Fallback to Node happens only here, before any
 * request is handed to a backend; a started session never re-sends elsewhere.
 */
export function resolveAcpMcpInvocation(
  input: ResolveAcpMcpInvocationInput,
): AcpMcpInvocation & {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly runAsNode: boolean;
} {
  const env = input.env ?? process.env;
  const record = input.recordDiagnostic ?? defaultRecordDiagnostic;
  const rawMode = env[ACP_MCP_BRIDGE_BACKEND_ENV]?.trim().toLowerCase();
  const mode: AcpMcpBridgeBackendMode =
    rawMode === undefined || rawMode === "" ? "auto" : (rawMode as AcpMcpBridgeBackendMode);
  if (mode !== "auto" && mode !== "node" && mode !== "rust") {
    throw new AcpMcpBridgeUnavailableError(
      `invalid ${ACP_MCP_BRIDGE_BACKEND_ENV} value: ${rawMode}`,
    );
  }

  const nodeInvocation = (reason: string, fallbackReason?: string) => {
    record({
      mode,
      backend: "node",
      reason,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
    });
    return {
      backend: "node" as const,
      command: input.self.command,
      args: selfInvocationArgs(input.self, ["acp-mcp-bridge"]),
      runAsNode: true,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
    };
  };

  if (mode === "node") return nodeInvocation("mode-node");

  const binaryPath = env[ACP_MCP_BRIDGE_BIN_ENV]?.trim();
  if (binaryPath === undefined || binaryPath === "") {
    if (mode === "rust") {
      throw new AcpMcpBridgeUnavailableError(`${ACP_MCP_BRIDGE_BIN_ENV} is not set`);
    }
    return nodeInvocation("rust-bin-unset");
  }

  const failOrFallback = (reason: string) => {
    if (mode === "rust") throw new AcpMcpBridgeUnavailableError(reason);
    return nodeInvocation("rust-unavailable", reason);
  };

  if (!isLoopbackHttpEndpoint(input.endpoint)) {
    return failOrFallback("endpoint-not-loopback-http");
  }
  const check = checkRustBridge(binaryPath, input.probe ?? defaultProbe);
  if (!check.ok) return failOrFallback(check.reason);

  record({
    mode,
    backend: "rust",
    reason: "rust-selected",
    binaryPath,
    binaryVersion: check.version,
    binarySha256: check.sha256,
  });
  return {
    backend: "rust" as const,
    command: binaryPath,
    args: ["acp-mcp-bridge"],
    runAsNode: false,
  };
}
