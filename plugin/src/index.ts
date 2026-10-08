import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { resolveConfig, type ResolvedPluginConfig } from "./config.js";
import { LeaseManager } from "./leases.js";
import { ProviderRegistry } from "./provider.js";
import { SSHManager } from "./ssh.js";
import { RuntimeState } from "./state.js";
import type { WorkspaceBinding, WorkspaceInfo, WorkspaceTarget } from "./types.js";

const leases = new LeaseManager();
const state = new RuntimeState();
let config: ResolvedPluginConfig;
let sshManager: SSHManager;
let providers: ProviderRegistry;

export interface WorkspaceAdapter {
  name: string;
  description: string;
  configure: (workspace: WorkspaceInfo) => WorkspaceInfo;
  create: (workspace: WorkspaceInfo) => Promise<void>;
  remove: (workspace: WorkspaceInfo) => Promise<void>;
  target: (workspace: WorkspaceInfo) => Promise<WorkspaceTarget>;
}

export interface PluginInput {
  experimental_workspace?: {
    register: (type: string, adapter: WorkspaceAdapter) => void;
  };
  [key: string]: unknown;
}

function providerRequestForWorkspace(workspace: WorkspaceInfo) {
  if (!workspace.extra || typeof (workspace.extra as Record<string, unknown>).provider !== "string") {
    throw new Error("Workspace extra.provider must be configured");
  }

  return {
    provider: (workspace.extra as Record<string, unknown>).provider as string,
    host: typeof (workspace.extra as Record<string, unknown>).host === "string"
      ? ((workspace.extra as Record<string, unknown>).host as string)
      : undefined,
    labels: Array.isArray((workspace.extra as Record<string, unknown>).labels)
      ? ((workspace.extra as Record<string, unknown>).labels as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createRemoteSession(binding: WorkspaceBinding, title = "Remote Session"): Promise<string> {
  const sessionID = `sess_${Date.now()}`;
  const response = await fetch(`http://127.0.0.1:${binding.localPort}/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${binding.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: sessionID, title, workspaceID: binding.workspaceID }),
  });

  if (!response.ok) {
    throw new Error(`Remote session create failed: HTTP ${response.status} ${await response.text()}`);
  }

  return sessionID;
}

async function createRemoteWorkspace(binding: WorkspaceBinding): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${binding.localPort}/experimental/workspace`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${binding.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: binding.workspaceID,
      type: "ssh-provider",
      name: "Remote Workspace",
      extra: { provider: binding.provider, host: binding.host },
    }),
  });

  if (!response.ok) {
    throw new Error(`Remote workspace create failed: HTTP ${response.status} ${await response.text()}`);
  }
}

async function createConnectedBinding(providerName: string, host: string | undefined, workspaceName: string): Promise<WorkspaceBinding> {
  const workspaceID = `remote-${Date.now()}-${workspaceName.replace(/\s+/g, "-")}`;
  const selection = providers.acquireResolved({ provider: providerName, host }, workspaceID);

  try {
    const bootstrap = await sshManager.bootstrap(workspaceID, selection);
    const binding: WorkspaceBinding = {
      workspaceID,
      provider: selection.provider,
      host: selection.host.name,
      remotePort: bootstrap.remotePort,
      localPort: bootstrap.localPort,
      token: bootstrap.token,
      leaseMode: config.defaults.leaseMode,
      status: "ready",
      tunnelPID: bootstrap.tunnelPID,
    };

    await createRemoteWorkspace(binding);
    binding.sessionID = await createRemoteSession(binding);
    setBinding(binding);
    return binding;
  } catch (error) {
    providers.release(selection.host.name, workspaceID);
    throw error;
  }
}

async function findReusableBinding(providerName: string, host?: string): Promise<WorkspaceBinding | undefined> {
  for (const binding of listBindings()) {
    if (binding.status === "removed" || binding.provider !== providerName) {
      continue;
    }

    try {
      const selection = providers.acquireResolved({ provider: providerName, host: host ?? binding.host }, binding.workspaceID);
      if (selection.host.name !== binding.host) {
        providers.release(selection.host.name, binding.workspaceID);
        continue;
      }

      const recovered = await sshManager.ensureRecoveredBinding(binding, selection);
      if (!recovered.sessionID) {
        recovered.sessionID = await createRemoteSession(recovered);
      }
      replaceBinding(recovered);
      return recovered;
    } catch {
      providers.release(binding.host, binding.workspaceID);
      state.delete(binding.workspaceID);
    }
  }

  return undefined;
}

async function removeRemoteWorkspace(binding: WorkspaceBinding): Promise<void> {
  if (binding.sessionID) {
    try {
      await fetch(`http://127.0.0.1:${binding.localPort}/session/${binding.sessionID}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${binding.token}` },
      });
    } catch {
      // Best-effort remote cleanup; local lease/tunnel cleanup still runs below.
    }
  }

  try {
    await fetch(`http://127.0.0.1:${binding.localPort}/experimental/workspace/${binding.workspaceID}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${binding.token}` },
    });
  } catch {
    // Best-effort remote cleanup; local lease/tunnel cleanup still runs below.
  }
}

async function ensureBindingReady(binding: WorkspaceBinding): Promise<WorkspaceBinding> {
  const selection = providers.acquireResolved({
    provider: binding.provider,
    host: binding.host,
  }, binding.workspaceID);
  const recovered = await sshManager.ensureRecoveredBinding(binding, selection);
  if (recovered.localPort !== binding.localPort || recovered.tunnelPID !== binding.tunnelPID || recovered.status !== binding.status) {
    state.replace(recovered);
    return recovered;
  }
  return binding;
}

function rehydrateLeasesFromState(): void {
  leases.clear();
  for (const binding of state.list()) {
    if (binding.status === "removed") {
      continue;
    }
    leases.restore(binding.host, binding.workspaceID, binding.leaseMode);
  }
}

async function removeBinding(binding: WorkspaceBinding): Promise<void> {
  await removeRemoteWorkspace(binding);
  await sshManager.closeRecoveredBinding(binding);
  providers.release(binding.host, binding.workspaceID);
  state.delete(binding.workspaceID);
}

function setBinding(binding: WorkspaceBinding): void {
  state.set(binding);
}

function replaceBinding(binding: WorkspaceBinding): void {
  state.replace(binding);
}

function listBindings(): WorkspaceBinding[] {
  return state.list();
}

function getBinding(workspaceID: string): WorkspaceBinding | undefined {
  return state.get(workspaceID);
}

async function getReadyBinding(workspaceID: string): Promise<WorkspaceBinding | undefined> {
  const binding = state.get(workspaceID);
  if (!binding) {
    return undefined;
  }
  return ensureBindingReady(binding);
}

function resolveProvider(workspace: WorkspaceInfo) {
  return providers.acquireResolved(providerRequestForWorkspace(workspace), workspace.id);
}

function configureWorkspace(workspace: WorkspaceInfo): WorkspaceInfo {
  const selection = resolveProvider(workspace);

  return {
    ...workspace,
    type: workspace.type || "ssh-provider",
    name: workspace.name ?? selection.host.name,
    extra: {
      ...(workspace.extra ?? {}),
      provider: selection.provider,
      host: selection.host.name,
    },
  };
}

async function createWorkspace(workspace: WorkspaceInfo): Promise<void> {
  const selection = providers.acquireResolved(providerRequestForWorkspace(workspace), workspace.id);

  try {
    const bootstrap = await sshManager.bootstrap(workspace.id, selection);

    setBinding({
      workspaceID: workspace.id,
      provider: selection.provider,
      host: selection.host.name,
      remotePort: bootstrap.remotePort,
      localPort: bootstrap.localPort,
      token: bootstrap.token,
      leaseMode: config.defaults.leaseMode,
      status: "ready",
      tunnelPID: bootstrap.tunnelPID,
    });
  } catch (error) {
    providers.release(selection.host.name, workspace.id);
    throw error;
  }
}

async function removeWorkspace(workspace: WorkspaceInfo): Promise<void> {
  const binding = getBinding(workspace.id);
  if (!binding) {
    return;
  }

  await removeBinding(binding);
}

async function getTarget(workspace: WorkspaceInfo): Promise<WorkspaceTarget> {
  const binding = await getReadyBinding(workspace.id);
  if (!binding) {
    throw new Error(`Workspace '${workspace.id}' is not active`);
  }

  return {
    type: "remote",
    url: `http://127.0.0.1:${binding.localPort}`,
    headers: {
      Authorization: `Bearer ${binding.token}`,
    },
  };
}

const sshProviderAdaptor: WorkspaceAdapter = {
  name: "SSH Provider",
  description: "Remote Linux host over SSH-backed Go stub",
  configure: configureWorkspace,
  create: createWorkspace,
  remove: removeWorkspace,
  target: getTarget,
};

function ensureInitialized(options?: Record<string, unknown>): void {
  if (!config) {
    config = resolveConfig((options as ResolvedPluginConfig | undefined) ?? { providers: {} });
    sshManager = new SSHManager(config);
    providers = new ProviderRegistry(config, leases);
    rehydrateLeasesFromState();
  }
}

interface ToolDefinition {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (input: any) => Promise<{ content: string }>;
}

function buildToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "remote-switch",
      description: "Connect to a configured remote SSH host and make it available as the active remote workspace",
      input: {
        type: "object",
        properties: {
          host: { type: "string", description: "Configured host name, ssh.host, or alias to connect to" },
          provider: { type: "string", description: "Provider name from plugin config" },
        },
        additionalProperties: false,
      },
      execute: async (args: { host?: string; provider?: string }) => {
        try {
          const providerName = args.provider || Object.keys(config.providers)[0] || "default";
          const binding = await findReusableBinding(providerName, args.host)
            ?? await createConnectedBinding(providerName, args.host, args.host || providerName);

          return {
            content: JSON.stringify({
              success: true,
              type: "remote",
              url: `http://127.0.0.1:${binding.localPort}`,
              headers: { Authorization: `Bearer ${binding.token}` },
              workspaceID: binding.workspaceID,
              sessionID: binding.sessionID,
              provider: binding.provider,
              host: binding.host,
              localPort: binding.localPort,
              message: `SWITCHED TO REMOTE: ${binding.host} on local port ${binding.localPort}`,
            }, null, 2),
          };
        } catch (error) {
          return { content: JSON.stringify({ success: false, error: errorMessage(error) }, null, 2) };
        }
      },
    },
    {
      name: "remote-status",
      description: "Check remote SSH workspace connection status and recover stale tunnels when possible",
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        const bindings = [];
        for (const binding of listBindings()) {
          try {
            bindings.push(await ensureBindingReady(binding));
          } catch (error) {
            state.delete(binding.workspaceID);
            providers.release(binding.host, binding.workspaceID);
            bindings.push({
              workspaceID: binding.workspaceID,
              provider: binding.provider,
              host: binding.host,
              status: "failed",
              error: errorMessage(error),
            });
          }
        }

        return {
          content: JSON.stringify({
            connected: bindings.some((binding) => binding.status === "ready"),
            workspaces: bindings,
          }, null, 2),
        };
      },
    },
    {
      name: "remote-disconnect",
      description: "Disconnect one or all remote SSH workspaces and return to local operation",
      input: {
        type: "object",
        properties: {
          workspaceID: { type: "string", description: "Workspace ID to disconnect; defaults to all active remote workspaces" },
        },
        additionalProperties: false,
      },
      execute: async (args: { workspaceID?: string }) => {
        const bindings = args.workspaceID ? listBindings().filter((binding) => binding.workspaceID === args.workspaceID) : listBindings();
        if (bindings.length === 0) {
          return { content: JSON.stringify({ success: false, error: "No active remote connection to disconnect." }) };
        }

        const removed: string[] = [];
        for (const binding of bindings) {
          await removeBinding(binding);
          removed.push(binding.workspaceID);
        }

        return { content: JSON.stringify({ success: true, removed, message: "Disconnected remote workspace connection(s)." }, null, 2) };
      },
    },
    {
      name: "remote-doctor",
      description: "Run a live remote SSH provider preflight by connecting, health-checking, and cleaning up a test workspace",
      input: {
        type: "object",
        properties: {
          host: { type: "string", description: "Configured host name, ssh.host, or alias to test" },
          provider: { type: "string", description: "Provider name from plugin config" },
        },
        additionalProperties: false,
      },
      execute: async (args: { host?: string; provider?: string }) => {
        const providerName = args.provider || Object.keys(config.providers)[0] || "default";
        let binding: WorkspaceBinding | undefined;
        let createdForDoctor = false;
        try {
          binding = await findReusableBinding(providerName, args.host);
          if (!binding) {
            binding = await createConnectedBinding(providerName, args.host, `doctor-${args.host || providerName}`);
            createdForDoctor = true;
          }
          const response = await fetch(`http://127.0.0.1:${binding.localPort}/global/health`, {
            headers: { Authorization: `Bearer ${binding.token}` },
          });
          if (!response.ok) {
            throw new Error(`Health check failed through target: HTTP ${response.status} ${await response.text()}`);
          }

          const health = await response.json();
          return {
            content: JSON.stringify({
              success: true,
              provider: binding.provider,
              host: binding.host,
              workspaceID: binding.workspaceID,
              sessionID: binding.sessionID,
              localPort: binding.localPort,
              reused: !createdForDoctor,
              health,
            }, null, 2),
          };
        } catch (error) {
          return { content: JSON.stringify({ success: false, error: errorMessage(error) }) };
        } finally {
          if (binding && createdForDoctor) {
            try {
              await removeBinding(binding);
            } catch {
              // Doctor should report the primary failure rather than hide it with cleanup noise.
            }
          }
        }
      },
    },
    {
      name: "remote-workspace-create",
      description: "Create a remote SSH workspace on a configured host",
      input: {
        type: "object",
        properties: {
          workspaceName: { type: "string", description: "Name for the workspace" },
          provider: { type: "string", description: "Provider name from plugin config" },
          host: { type: "string", description: "Specific configured host name to use" },
        },
        required: ["workspaceName"],
        additionalProperties: false,
      },
      execute: async (args: { workspaceName: string; provider?: string; host?: string }) => {
        try {
          const providerName = args.provider || Object.keys(config.providers)[0];
          if (!providerName) {
            throw new Error("No providers configured for opencode-remote-provider");
          }

          const workspaceID = `remote-${Date.now()}-${args.workspaceName.replace(/\s+/g, "-")}`;
          const selection = providers.acquireResolved({
            provider: providerName,
            host: args.host,
          }, workspaceID);

          try {
            const bootstrap = await sshManager.bootstrap(workspaceID, selection);
            setBinding({
              workspaceID,
              provider: selection.provider,
              host: selection.host.name,
              remotePort: bootstrap.remotePort,
              localPort: bootstrap.localPort,
              token: bootstrap.token,
              leaseMode: config.defaults.leaseMode,
              status: "ready",
              tunnelPID: bootstrap.tunnelPID,
            });
          } catch (error) {
            providers.release(selection.host.name, workspaceID);
            throw error;
          }

          return {
            content: JSON.stringify({
              success: true,
              workspaceID,
              provider: selection.provider,
              host: selection.host.name,
              message: `Remote workspace '${args.workspaceName}' created on ${selection.host.name}`,
            }, null, 2),
          };
        } catch (error) {
          return {
            content: JSON.stringify({
              success: false,
              error: errorMessage(error),
            }),
          };
        }
      },
    },
    {
      name: "remote-workspace-list",
      description: "List active remote workspaces",
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        const recovered = [];
        for (const binding of listBindings()) {
          recovered.push(await ensureBindingReady(binding));
        }
        return { content: JSON.stringify({ workspaces: recovered }, null, 2) };
      },
    },
    {
      name: "remote-workspace-remove",
      description: "Remove a remote workspace",
      input: {
        type: "object",
        properties: {
          workspaceID: { type: "string", description: "Workspace ID to remove" },
        },
        required: ["workspaceID"],
        additionalProperties: false,
      },
      execute: async (args: { workspaceID: string }) => {
        const binding = getBinding(args.workspaceID);
        if (!binding) {
          return { content: JSON.stringify({ success: false, error: "Workspace not found" }) };
        }

        await removeBinding(binding);
        return { content: JSON.stringify({ success: true, message: `Workspace ${args.workspaceID} removed` }) };
      },
    },
    {
      name: "remote-shell",
      description: "Execute a shell command on the active remote SSH workspace host",
      input: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute on the remote host" },
          workspaceID: { type: "string", description: "Remote workspace ID (defaults to active remote workspace)" },
          cwd: { type: "string", description: "Working directory on the remote host" },
          autoApprove: { type: "boolean", description: "Auto-approve path access permissions if requested (default true)" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (args: { command: string; workspaceID?: string; cwd?: string; autoApprove?: boolean }) => {
        try {
          let binding: WorkspaceBinding | undefined;
          if (args.workspaceID) {
            binding = getBinding(args.workspaceID);
          } else {
            const readyBindings = listBindings().filter((b) => b.status === "ready");
            binding = readyBindings[0];
          }

          if (!binding) {
            throw new Error("No active remote workspace found. Use remote-switch or remote-workspace-create first.");
          }

          binding = await ensureBindingReady(binding);
          if (!binding.sessionID) {
            binding.sessionID = await createRemoteSession(binding);
            replaceBinding(binding);
          }

          const jsonHeaders = {
            Authorization: `Bearer ${binding.token}`,
            "Content-Type": "application/json",
          };
          const baseURL = `http://127.0.0.1:${binding.localPort}`;

          let shellResponse = await fetch(`${baseURL}/session/${binding.sessionID}/shell`, {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({
              command: args.command,
              cwd: args.cwd || "",
            }),
          });

          if (shellResponse.status === 403 && args.autoApprove !== false) {
            const permRes = await fetch(`${baseURL}/permission`, {
              headers: { Authorization: `Bearer ${binding.token}` },
            });
            if (permRes.ok) {
              const perms = (await permRes.json()) as Array<{ id: string; sessionID: string; permission: string }>;
              const req = perms.find((p) => p.sessionID === binding!.sessionID && p.permission === "path.access");
              if (req) {
                await fetch(`${baseURL}/permission/${req.id}/reply`, {
                  method: "POST",
                  headers: jsonHeaders,
                  body: JSON.stringify({ reply: "always" }),
                });
                shellResponse = await fetch(`${baseURL}/session/${binding.sessionID}/shell`, {
                  method: "POST",
                  headers: jsonHeaders,
                  body: JSON.stringify({
                    command: args.command,
                    cwd: args.cwd || "",
                  }),
                });
              }
            }
          }

          if (!shellResponse.ok) {
            const text = await shellResponse.text();
            throw new Error(`Remote shell failed (HTTP ${shellResponse.status}): ${text}`);
          }

          const result = await shellResponse.json();
          return { content: JSON.stringify(result, null, 2) };
        } catch (error) {
          return { content: JSON.stringify({ success: false, error: errorMessage(error) }, null, 2) };
        }
      },
    },
  ];
}

export const RemoteSSHPlugin = Plugin.define({
  id: "opencode-remote-ssh",
  async setup(ctx: Context) {
    ensureInitialized(ctx.options as Record<string, unknown> | undefined);

    const tools = buildToolDefinitions();

    await ctx.tool.transform((editor) => {
      for (const t of tools) {
        // Register primary tool name
        editor.add({
          name: t.name,
          description: t.description,
          input: t.input as any,
          execute: t.execute,
        });

        // Also register underscore alias (e.g. remote_switch in addition to remote-switch)
        const underscoreName = t.name.replace(/-/g, "_");
        if (underscoreName !== t.name) {
          editor.add({
            name: underscoreName,
            description: t.description,
            input: t.input as any,
            execute: t.execute,
          });
        }
      }
    });

    return async () => {
      // Cleanup on unload if needed
    };
  },
});

export async function OpencodeRemotePluginV1(input?: PluginInput, options?: Record<string, unknown>) {
  ensureInitialized(options);

  if (input?.experimental_workspace) {
    input.experimental_workspace.register("ssh-provider", sshProviderAdaptor);
  }

  const tools = buildToolDefinitions();
  const v1Tools: Record<string, unknown> = {};

  for (const t of tools) {
    v1Tools[t.name] = {
      description: t.description,
      args: t.input,
      execute: async (args: any) => {
        const result = await t.execute(args);
        return result.content;
      },
    };
    const underscoreName = t.name.replace(/-/g, "_");
    if (underscoreName !== t.name) {
      v1Tools[underscoreName] = v1Tools[t.name];
    }
  }

  return {
    tool: v1Tools,
  };
}

export default {
  ...RemoteSSHPlugin,
  server: OpencodeRemotePluginV1,
};
export type { PluginConfig } from "./types.js";
