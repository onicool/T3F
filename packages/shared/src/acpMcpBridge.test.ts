import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  AcpMcpBridgeUnavailableError,
  clearAcpMcpBridgeVerificationCache,
  resolveAcpMcpInvocation,
  type RustBridgeProbe,
} from "./acpMcpBridge.ts";
import type { SelfInvocation } from "./nodeRuntime.ts";

const self: SelfInvocation = { command: "/opt/t3/t3", entrypoint: "/opt/t3/main.js" };
const loopbackEndpoint = "http://127.0.0.1:3773/mcp";

const workingProbe: RustBridgeProbe = {
  stat: () => ({ isFile: true, executable: true }),
  version: () => "0.1.0",
  sha256: () => "abc123",
};

const resolve = (env: NodeJS.ProcessEnv, overrides?: Partial<Parameters<typeof resolveAcpMcpInvocation>[0]>) =>
  resolveAcpMcpInvocation({
    self,
    endpoint: loopbackEndpoint,
    env,
    probe: workingProbe,
    recordDiagnostic: () => {},
    ...overrides,
  });

describe("resolveAcpMcpInvocation", () => {
  beforeEach(() => {
    clearAcpMcpBridgeVerificationCache();
  });

  it("keeps the legacy Node invocation when nothing is configured", () => {
    const invocation = resolve({});
    expect(invocation.backend).toBe("node");
    expect(invocation.command).toBe(self.command);
    expect(invocation.args).toEqual(["/opt/t3/main.js", "acp-mcp-bridge"]);
    expect(invocation.runAsNode).toBe(true);
    expect(invocation.fallbackReason).toBeUndefined();
  });

  it("never selects Rust in node mode, even with a binary configured", () => {
    const invocation = resolve({ T3F_BRIDGE_BACKEND: "node", T3_RUST_BRIDGE_BIN: "/opt/t3f-bridge" });
    expect(invocation.backend).toBe("node");
    expect(invocation.fallbackReason).toBeUndefined();
  });

  it("selects the Rust binary directly in auto mode when it verifies", () => {
    const invocation = resolve({ T3_RUST_BRIDGE_BIN: "/opt/t3f-bridge" });
    expect(invocation.backend).toBe("rust");
    expect(invocation.command).toBe("/opt/t3f-bridge");
    expect(invocation.args).toEqual(["acp-mcp-bridge"]);
    expect(invocation.runAsNode).toBe(false);
  });

  it("falls back to Node in auto mode when the binary is missing", () => {
    const invocation = resolve(
      { T3_RUST_BRIDGE_BIN: "/opt/t3f-bridge" },
      { probe: { ...workingProbe, stat: () => undefined } },
    );
    expect(invocation.backend).toBe("node");
    expect(invocation.fallbackReason).toBe("binary-not-found");
  });

  it("falls back to Node in auto mode for an HTTPS endpoint", () => {
    const invocation = resolve(
      { T3_RUST_BRIDGE_BIN: "/opt/t3f-bridge" },
      { endpoint: "https://example.com/mcp" },
    );
    expect(invocation.backend).toBe("node");
    expect(invocation.fallbackReason).toBe("endpoint-not-loopback-http");
  });

  it("fails explicitly in rust mode without a binary path", () => {
    expect(() => resolve({ T3F_BRIDGE_BACKEND: "rust" })).toThrow(AcpMcpBridgeUnavailableError);
  });

  it("fails explicitly in rust mode when verification fails", () => {
    expect(() =>
      resolve(
        { T3F_BRIDGE_BACKEND: "rust", T3_RUST_BRIDGE_BIN: "/opt/t3f-bridge" },
        { probe: { ...workingProbe, version: () => "9.9.9" } },
      ),
    ).toThrow(/unsupported-version:9\.9\.9/);
  });

  it("fails explicitly in rust mode for an HTTPS endpoint", () => {
    expect(() =>
      resolve(
        { T3F_BRIDGE_BACKEND: "rust", T3_RUST_BRIDGE_BIN: "/opt/t3f-bridge" },
        { endpoint: "https://example.com/mcp" },
      ),
    ).toThrow(/endpoint-not-loopback-http/);
  });

  it("verifies a binary only once per path", () => {
    let versionCalls = 0;
    const countingProbe: RustBridgeProbe = {
      ...workingProbe,
      version: () => {
        versionCalls += 1;
        return "0.1.0";
      },
    };
    resolve({ T3_RUST_BRIDGE_BIN: "/opt/t3f-bridge" }, { probe: countingProbe });
    resolve({ T3_RUST_BRIDGE_BIN: "/opt/t3f-bridge" }, { probe: countingProbe });
    expect(versionCalls).toBe(1);
  });
});
