import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DefaultsConfig, PluginConfig, ProviderConfig, TunnelConfig } from "./types.js";

const DEFAULT_TUNNEL: Required<TunnelConfig> = {
  localPortRange: [39000, 39999],
  connectTimeoutMs: 15_000,
  healthTimeoutMs: 5_000,
  portScanTimeoutMs: 60_000,
};

const DEFAULTS: Required<DefaultsConfig> = {
  selectionStrategy: "first_available",
  leaseMode: "exclusive",
  stubPort: 39217,
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function findDefaultStubBinary(): string {
  const candidates = [
    resolve(join(MODULE_DIR, "../../stub/bin/opencode-remote-stub")),
    resolve(join(MODULE_DIR, "../stub/bin/opencode-remote-stub")),
    resolve(join(MODULE_DIR, "stub/bin/opencode-remote-stub")),
    resolve(join(MODULE_DIR, "../../../stub/bin/opencode-remote-stub")),
    join(homedir(), ".config", "opencode", "opencode-remote-ssh", "stub", "bin", "opencode-remote-stub"),
    join(homedir(), ".opencode-remote", "bin", "opencode-remote-stub"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

const DEFAULT_STUB_BINARY = findDefaultStubBinary();

function loadConfigFromOpenCodeJson(): PluginConfig | undefined {
  const configPath = join(homedir(), ".config", "opencode", "opencode.json");
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = readFileSync(configPath, "utf8");
    const stripped = raw.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => (g ? "" : m));
    const data = JSON.parse(stripped);
    if (Array.isArray(data.plugins)) {
      for (const entry of data.plugins) {
        if (typeof entry === "object" && entry !== null && entry.package) {
          const pkg = String(entry.package);
          if ((pkg.includes("remote-ssh") || pkg.includes("remote-provider") || pkg === "opencode-remote-provider") && entry.options?.providers) {
            return entry.options as PluginConfig;
          }
        }
      }
    }
    if (Array.isArray(data.plugin)) {
      for (const entry of data.plugin) {
        if (Array.isArray(entry) && entry.length >= 2 && String(entry[0]).includes("remote")) {
          return entry[1] as PluginConfig;
        }
      }
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

export interface ResolvedPluginConfig extends PluginConfig {
  installRoot: string;
  stubBinaryPath: string;
  tunnel: Required<TunnelConfig>;
  defaults: Required<DefaultsConfig>;
  providers: Record<string, ProviderConfig>;
}

export function resolveConfig(input: PluginConfig): ResolvedPluginConfig {
  // If no input or no providers, attempt loading from ~/.config/opencode/opencode.json
  if (!input || !input.providers || Object.keys(input.providers).length === 0) {
    const fromFile = loadConfigFromOpenCodeJson();
    if (fromFile && fromFile.providers && Object.keys(fromFile.providers).length > 0) {
      input = { ...fromFile, ...input, providers: fromFile.providers };
    }
  }

  // If still no providers, return empty config and let it fail gracefully at runtime
  if (!input || !input.providers || Object.keys(input.providers).length === 0) {
    return {
      installRoot: "~/.opencode-remote",
      stubBinaryPath: DEFAULT_STUB_BINARY,
      tunnel: DEFAULT_TUNNEL,
      defaults: DEFAULTS,
      providers: {},
    };
  }

  // Filter out invalid providers
  const validProviders: Record<string, ProviderConfig> = {};
  for (const [providerName, provider] of Object.entries(input.providers)) {
    if (provider.hosts && provider.hosts.length > 0) {
      const validHosts = provider.hosts.filter(h => h.name && h.ssh?.host && h.ssh?.user);
      if (validHosts.length > 0) {
        validProviders[providerName] = { ...provider, hosts: validHosts };
      }
    }
  }

  return {
    ...input,
    installRoot: input.installRoot ?? "~/.opencode-remote",
    stubBinaryPath: input.stubBinaryPath
      ? resolve(input.stubBinaryPath.replace(/^~\//, `${homedir()}/`))
      : findDefaultStubBinary(),
    tunnel: {
      ...DEFAULT_TUNNEL,
      ...input.tunnel,
    },
    defaults: {
      ...DEFAULTS,
      ...input.defaults,
    },
    providers: validProviders,
  };
}
