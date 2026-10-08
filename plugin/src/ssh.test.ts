import { spawn, execFileSync } from "node:child_process";
import { resolveConfig } from "./config.js";
import { SSHManager } from "./ssh.js";
import type { ResolvedHost, WorkspaceBinding } from "./types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const config = resolveConfig({
  providers: {
    default: {
      hosts: [
        { name: "h1", ssh: { host: "192.0.2.1", user: "root", port: 22 } },
        { name: "h2", ssh: { host: "192.0.2.2", user: "root", port: 22 } },
        // The probe forward below targets a configurable host, which must be a
        // managed host for reclaim to be allowed to touch it.
        {
          name: "probe",
          ssh: {
            host: process.env.OPENCODE_REMOTE_TEST_HOST ?? "127.0.0.1",
            user: process.env.OPENCODE_REMOTE_TEST_USER ?? "root",
            port: 22,
          },
        },
      ],
    },
  },
});

const manager = new SSHManager(config) as unknown as Record<string, (...args: any[]) => any>;

const target: ResolvedHost = {
  provider: "default",
  host: { name: "h1", ssh: { host: "192.0.2.1", user: "root", port: 22 } },
  labels: [],
  strategy: "first_available",
};

function binding(overrides: Partial<WorkspaceBinding> = {}): WorkspaceBinding {
  return {
    workspaceID: "ws",
    provider: "default",
    host: "h1",
    remotePort: 39217,
    localPort: 0,
    token: "t",
    leaseMode: "exclusive",
    status: "ready",
    ...overrides,
  };
}

// The probe needs a real, long-lived ssh process: a forward to a real host
// whose remote end is dead. Spawning toward a host that refuses auth would exit
// immediately and never bind, which would test nothing.
const PROBE_HOST = process.env.OPENCODE_REMOTE_TEST_HOST;
const PROBE_USER = process.env.OPENCODE_REMOTE_TEST_USER ?? "root";
const PROBE_IDENTITY = process.env.OPENCODE_REMOTE_TEST_IDENTITY;

function startStaleForward(localPort: number): number | undefined {
  const args = [
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    // Remote port 1 has nothing listening, so this mirrors a forward left behind
    // by a stub that has since died.
    `${localPort}:127.0.0.1:1`,
    "-p",
    "22",
  ];
  if (PROBE_IDENTITY) {
    args.push("-i", PROBE_IDENTITY);
  }
  args.push(`${PROBE_USER}@${PROBE_HOST}`);

  const child = spawn("ssh", args, { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

function probeConfigured(): boolean {
  return Boolean(PROBE_HOST);
}

async function testIsPortBoundDetectsSilentForward() {
  const port = 39391;
  const pid = startStaleForward(port);
  assert(pid, "expected to spawn a probe ssh");

  // Wait for the forward to bind.
  // An unused port must read as free, otherwise no tunnel could ever be opened.
  const freePort = 39399;
  assert(!(await manager.isPortBound(freePort)), "expected an unused port to read as free");

  const deadline = Date.now() + 5000;
  let bound = false;
  while (Date.now() < deadline) {
    if (await manager.isPortBound(port)) {
      bound = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  assert(bound, "expected isPortBound to report a bound-but-silent forward");
  // The health probe alone would say "free", which is the bug this guards.
  const reachable = await manager.isPortReachable(port);
  assert(reachable === false, "expected no health response from a dead remote end");

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function testReclaimKillsOnlyManagedForward() {
  const port = 39392;
  const pid = startStaleForward(port);
  assert(pid, "expected to spawn a reclaim probe ssh");

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(await manager.isPortBound(port))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(await manager.isPortBound(port), "probe forward never bound its port");

  // Target a different host: nothing must be reclaimed.
  manager.reclaimOrphanTunnel(port, 1, "192.0.2.99", "root");
  await new Promise((r) => setTimeout(r, 300));
  assert(await manager.isPortBound(port), "reclaim must not touch a forward for an unmanaged host");

  // Target the forward's real host and remote port: it must be reclaimed.
  manager.reclaimOrphanTunnel(port, 1, PROBE_HOST!, PROBE_USER);
  const releaseDeadline = Date.now() + 5000;
  while (Date.now() < releaseDeadline && (await manager.isPortBound(port))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(!(await manager.isPortBound(port)), "expected the managed orphan forward to be reclaimed");

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function testFailedReconnectDoesNotLeakTunnel() {
  const ssh = new SSHManager(config);
  const host = process.env.OPENCODE_REMOTE_TEST_HOST ?? "127.0.0.1";
  const user = process.env.OPENCODE_REMOTE_TEST_USER ?? "root";
  const probeTarget: ResolvedHost = {
    provider: "default",
    host: { name: "probe", ssh: { host, user, port: 22 } },
    labels: [],
    strategy: "first_available",
  };

  // A binding whose token cannot authenticate never passes the health check, so
  // the reconnect fails after opening a tunnel. That tunnel must be closed again,
  // or every discarded stale binding leaves a port bound.
  const port = 39393;
  const stale = binding({ workspaceID: "leak-1", host: "probe", localPort: port, token: "deadbeef" });

  try {
    await ssh.ensureRecoveredBinding(stale, probeTarget);
  } catch {
    // Expected: the bogus token cannot reach a healthy stub.
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await manager.isPortBound(port))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(!(await manager.isPortBound(port)), "a failed reconnect must not leave its tunnel bound");
}

async function testStartCommandDoesNotChainTwoHeredocs() {
  const cmd = manager.buildRemoteStartCommand("/root/.opencode-remote", 39217) as string;
  // A `python - <<'PY' ... || python - <<'PY'` chain gives the fallback an empty
  // stdin, which silently started nothing.
  const heredocs = cmd.match(/<<'PY'/g) ?? [];
  assert(heredocs.length <= 1, `expected at most one heredoc body, found ${heredocs.length}`);
  assert(cmd.includes("setsid") || cmd.includes("preexec_fn=os.setsid"), "expected a detached start path");
}

async function run() {
  // The port-detection tests need a real ssh forward, which needs a reachable
  // host. Without one, the offline checks below still run and the suite reports
  // that the forward-dependent coverage was skipped rather than silently passing.
  await testStartCommandDoesNotChainTwoHeredocs();

  if (probeConfigured()) {
    await testIsPortBoundDetectsSilentForward();
    await testReclaimKillsOnlyManagedForward();
    await testFailedReconnectDoesNotLeakTunnel();
  } else {
    console.log("ssh.test.ts: skipped forward tests (set OPENCODE_REMOTE_TEST_HOST)");
  }

  console.log("ssh.test.ts: ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
