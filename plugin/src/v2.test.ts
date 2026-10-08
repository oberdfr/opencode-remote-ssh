import plugin, { RemoteSSHPlugin, OpencodeRemotePluginV1 } from "./index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function testV2PluginDefinition() {
  assert(plugin.id === "opencode-remote-ssh", `expected plugin.id === 'opencode-remote-ssh', got ${plugin.id}`);
  assert(typeof plugin === "object", "expected default export to be an object definition for V2");
  assert(typeof plugin.setup === "function", "expected plugin.setup to be a function");
  assert(typeof plugin.server === "function", "expected plugin.server to be a function (V1 compatibility)");
}

async function testV2SetupRegistersTools() {
  const registeredTools: Array<{ name: string; description: string; input: any }> = [];

  const mockCtx: any = {
    options: {
      providers: {
        default: {
          strategy: "first_available",
          hosts: [
            {
              name: "test-host",
              ssh: { host: "1.2.3.4", user: "test", port: 22 },
            },
          ],
        },
      },
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        const editor = {
          add: (toolDef: any) => {
            registeredTools.push(toolDef);
          },
        };
        callback(editor);
      },
    },
  };

  await plugin.setup(mockCtx);

  const toolNames = registeredTools.map((t) => t.name);

  // Check expected V2 tools (both hyphenated and underscored)
  const expectedTools = [
    "remote-switch",
    "remote_switch",
    "remote-status",
    "remote_status",
    "remote-disconnect",
    "remote_disconnect",
    "remote-doctor",
    "remote_doctor",
    "remote-workspace-create",
    "remote_workspace_create",
    "remote-workspace-list",
    "remote_workspace_list",
    "remote-workspace-remove",
    "remote_workspace_remove",
    "remote-shell",
    "remote_shell",
  ];

  for (const expected of expectedTools) {
    assert(toolNames.includes(expected), `expected tool '${expected}' to be registered, but got: ${toolNames.join(", ")}`);
  }
}

async function testCanonicalHostNameIgnoresLeases() {
  const { ProviderRegistry } = await import("./provider.js");
  const { LeaseManager } = await import("./leases.js");
  const { resolveConfig } = await import("./config.js");

  const config = resolveConfig({
    providers: {
      default: {
        hosts: [
          { name: "pve", aliases: ["proxmox"], ssh: { host: "192.0.2.10", user: "root" } },
          { name: "llm", ssh: { host: "192.0.2.25", user: "root" } },
        ],
      },
    },
  });

  const leases = new LeaseManager();
  const registry = new ProviderRegistry(config, leases);

  // Lease pve exclusively, then resolve it as a reuse target. resolve() refuses
  // a leased host, so using it here made a switch to an already-bound host throw
  // instead of reusing the existing binding.
  registry.acquireResolved({ provider: "default", host: "pve" }, "ws-1");

  let threw = false;
  try {
    registry.resolve({ provider: "default", host: "pve" });
  } catch {
    threw = true;
  }
  assert(threw, "precondition: resolve() refuses a leased host");

  assert(
    registry.canonicalHostName("default", "pve") === "pve",
    "canonicalHostName must resolve a leased host by name",
  );
  assert(
    registry.canonicalHostName("default", "192.0.2.25") === "llm",
    "canonicalHostName must resolve by ssh.host",
  );
  assert(
    registry.canonicalHostName("default", "proxmox") === "pve",
    "canonicalHostName must resolve by alias",
  );
  assert(
    registry.canonicalHostName("default", "llm") === "llm",
    "canonicalHostName must resolve a free host too",
  );
}

async function run() {
  await testV2PluginDefinition();
  await testV2SetupRegistersTools();
  await testCanonicalHostNameIgnoresLeases();
  console.log("v2.test.ts: ok");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
