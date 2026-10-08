import { randomBytes } from "node:crypto";
import net from "node:net";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ResolvedPluginConfig } from "./config.js";
import type { ResolvedHost, WorkspaceBinding } from "./types.js";

const execFileAsync = promisify(execFile);
const knownHostsFile = `${process.env.HOME ?? ""}/.ssh/known_hosts`;

export interface BootstrapResult {
  remotePort: number;
  localPort: number;
  token: string;
  installRoot: string;
  remoteHome: string;
  launchCommand: string;
  healthURL: string;
  tunnelPID?: number;
}

export class SSHManager {
  constructor(private readonly config: ResolvedPluginConfig) {}

  async bootstrap(workspaceID: string, target: ResolvedHost): Promise<BootstrapResult> {
    const sshConfig = target.host.ssh;
    const identityFile = sshConfig.identityFile
      ? sshConfig.identityFile.replace(/^~\//, `${process.env.HOME}/`)
      : undefined;
    const remotePort = this.config.defaults.stubPort;
    const remoteHome = await this.resolveRemoteHome(sshConfig, identityFile);
    const installRoot = this.expandInstallRoot(remoteHome);
    const token = randomBytes(24).toString("hex");
    const sshArgs = this.buildSSHArgs(sshConfig, identityFile);
    const stubBinary = `${installRoot}/bin/opencode-remote-stub`;
    const tokenFile = `${installRoot}/run/stub.token`;
    const stubPath = this.config.stubBinaryPath;
    const tokenDir = mkdtempSync(join(tmpdir(), "opencode-remote-token-"));
    const tokenPath = join(tokenDir, "stub.token");

    await this.execSSH(sshArgs, `mkdir -p ${installRoot}/bin ${installRoot}/run ${installRoot}/log ${installRoot}/state`);

    if (!existsSync(stubPath)) {
      throw new Error(`Stub binary not found at '${stubPath}'. Build it first or set plugin.stubBinaryPath.`);
    }

    const localStubHash = this.sha256File(stubPath);
    const remoteStubHash = await this.remoteStubHash(sshArgs, stubBinary);
    if (remoteStubHash !== localStubHash) {
      await this.installStub(stubPath, sshArgs, sshConfig, identityFile, stubBinary);
    }

    writeFileSync(tokenPath, token, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    try {
      await this.scp(tokenPath, sshConfig, identityFile, `${sshConfig.user}@${sshConfig.host}:${tokenFile}`);
    } finally {
      try {
        unlinkSync(tokenPath);
      } finally {
        rmSync(tokenDir, { recursive: true, force: true });
      }
    }

    // Stop only this install root's stub, never every stub on the host.
    //
    // A pattern-wide `pkill -f opencode-remote-stub` also matched the stubs of
    // sibling containers and of any other install root, because a pattern match
    // sees the full command line and this plugin's stub is always launched with
    // this same binary name. On a Proxmox host where the configured hosts are LXC
    // containers, bootstrapping one host killed the healthy workspaces of all the
    // others, which then surfaced as unreachable tunnels.
    //
    // Matching the resolved install-root path is precise: a sibling container's
    // install root resolves to a different path and is left running.
    const escapedInstallRoot = installRoot.replace(/'/g, `'\\''`);
    const stopExisting = [
      `ROOT='${escapedInstallRoot}'`,
      "PIDS=$(ps -eo pid=,args= 2>/dev/null | awk -v root=\"$ROOT/bin/opencode-remote-stub\" 'index($0, root) {print $1}')",
      'if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null || true; fi',
    ].join("; ");

    await this.execSSHAllowFailure(sshArgs, stopExisting);
    // Give the old stub a moment to release the listen socket before rebinding.
    await this.sleep(500);
    await this.execSSH(sshArgs, `mkdir -p ${installRoot}/log`);
    await this.execSSH(sshArgs, this.buildRemoteStartCommand(installRoot, remotePort));

    const { localPort, tunnelPID } = await this.ensureTunnel(workspaceID, target.host.name, sshConfig, identityFile, remotePort);

    try {
      await this.waitForHealth(localPort, token);
    } catch (error) {
      // Bootstrap owns this tunnel, so a failed bootstrap must not leave it bound.
      // The stub started for this attempt is stopped too, because a half-started
      // stub only makes the next attempt slower.
      await this.closeTunnel(localPort, tunnelPID).catch(() => {});
      await this.execSSHAllowFailure(sshArgs, stopExisting).catch(() => {});
      throw error;
    }

    return {
      remotePort,
      localPort,
      token,
      installRoot,
      remoteHome,
      launchCommand: this.buildLaunchCommand(installRoot, remotePort),
      healthURL: `http://127.0.0.1:${localPort}/global/health`,
      tunnelPID,
    };
  }

  async teardown(binding: WorkspaceBinding): Promise<void> {
    await this.closeTunnel(binding.localPort, binding.tunnelPID);
    await this.waitForPortClosed(binding.localPort);
  }

  async reconnect(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    const sshConfig = target.host.ssh;
    const identityFile = sshConfig.identityFile
      ? sshConfig.identityFile.replace(/^~\//, `${process.env.HOME}/`)
      : undefined;

    if (await this.isHealthReachable(binding.localPort, binding.token)) {
      return binding;
    }

    // An ssh forward can outlive the remote stub and keep holding the local port
    // while nothing answers on it. Reconnecting on that port would fail to bind
    // and, worse, look like a live connection, so the orphan is reclaimed first.
    if (await this.isPortBound(binding.localPort)) {
      this.reclaimOrphanTunnel(binding.localPort, binding.remotePort, sshConfig.host, sshConfig.user);
      await this.waitForPortReleased(binding.localPort);
    }

    const tunnel = await this.ensureSpecificOrFallbackTunnel(
      binding.workspaceID,
      target.host.name,
      sshConfig,
      identityFile,
      binding.remotePort,
      binding.localPort,
    );

    try {
      await this.waitForHealth(tunnel.localPort, binding.token);
    } catch (error) {
      // The tunnel this call just opened is not the caller's to keep: a failed
      // reconnect is about to be discarded, and leaking the forward would hold a
      // local port for every later attempt. Without this, each discarded stale
      // binding left an orphan behind and the next reconnect had to reclaim it.
      await this.closeTunnel(tunnel.localPort, tunnel.tunnelPID).catch(() => {});
      throw error;
    }

    return {
      ...binding,
      localPort: tunnel.localPort,
      tunnelPID: tunnel.tunnelPID,
      status: "ready",
    };
  }

  private buildSSHArgs(
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile?: string,
  ): string[] {
    const args = [
      "-o",
      "BatchMode=yes",
      "-o",
      "NumberOfPasswordPrompts=0",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsFile}`,
      "-o",
      `ConnectTimeout=${Math.ceil(this.config.tunnel.connectTimeoutMs / 1000)}`,
      "-p",
      String(sshConfig.port || 22),
    ];

    if (identityFile && existsSync(identityFile)) {
      args.push("-i", identityFile);
    }

    if (sshConfig.proxyJump) {
      args.push("-J", sshConfig.proxyJump);
    }

    args.push(`${sshConfig.user}@${sshConfig.host}`);
    return args;
  }

  private async execSSH(sshArgs: string[], command: string): Promise<string> {
    const { stdout } = await execFileAsync("ssh", [...sshArgs, command], {
      timeout: this.config.tunnel.connectTimeoutMs * 2,
    });
    return stdout.trim();
  }

  private async execSSHAllowFailure(sshArgs: string[], command: string): Promise<string> {
    try {
      return await this.execSSH(sshArgs, command);
    } catch {
      return "";
    }
  }

  private async scp(
    localPath: string,
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    destination: string,
  ): Promise<void> {
    const args = [
      "-o",
      "BatchMode=yes",
      "-o",
      "NumberOfPasswordPrompts=0",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsFile}`,
      "-P",
      String(sshConfig.port || 22),
    ];

    if (identityFile && existsSync(identityFile)) {
      args.push("-i", identityFile);
    }

    if (sshConfig.proxyJump) {
      args.push("-o", `ProxyJump=${sshConfig.proxyJump}`);
    }

    await execFileAsync("scp", [...args, localPath, destination], {
      timeout: this.config.tunnel.connectTimeoutMs * 4,
    });
  }

  private async installStub(
    localPath: string,
    sshArgs: string[],
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    remotePath: string,
  ): Promise<void> {
    const tempPath = `${remotePath}.upload-${process.pid}-${Date.now()}`;
    await this.scp(localPath, sshConfig, identityFile, `${sshConfig.user}@${sshConfig.host}:${tempPath}`);
    const escapedTemp = tempPath.replace(/'/g, `'\''`);
    const escapedRemote = remotePath.replace(/'/g, `'\''`);
    await this.execSSH(
      sshArgs,
      `chmod +x '${escapedTemp}' && mv -f '${escapedTemp}' '${escapedRemote}' && chmod +x '${escapedRemote}'`,
    );
  }

  private sha256File(path: string): string {
    const hash = createHash("sha256");
    hash.update(readFileSync(path));
    return hash.digest("hex");
  }

  private async remoteStubHash(sshArgs: string[], remotePath: string): Promise<string | undefined> {
    const escapedPath = remotePath.replace(/'/g, `'\\''`);
    const output = await this.execSSHAllowFailure(
      sshArgs,
      `if [ -f '${escapedPath}' ]; then sha256sum '${escapedPath}' 2>/dev/null | awk '{print $1}'; fi`,
    );
    const hash = output.trim();
    return hash || undefined;
  }

  private async resolveRemoteHome(
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile?: string,
  ): Promise<string> {
    const sshArgs = this.buildSSHArgs(sshConfig, identityFile);
    const home = await this.execSSH(sshArgs, "printf '%s' \"$HOME\"");
    if (!home) {
      throw new Error(`Unable to determine remote home for ${sshConfig.user}@${sshConfig.host}`);
    }
    return home;
  }

  private async ensureTunnel(
    workspaceID: string,
    host: string,
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    remotePort: number,
  ): Promise<{ localPort: number; tunnelPID?: number }> {
    const [start, end] = this.config.tunnel.localPortRange;
    const span = end - start + 1;
    const initialPort = this.allocateInitialLocalPort(workspaceID, host);

    // Cap the whole scan in time, not just in attempts.
    //
    // A forward whose remote end is dead stays alive and bound, so waiting for it
    // to answer costs the full connect timeout per candidate port. Across a wide
    // range that turned one dead stub into an unbounded stall. The budget stops
    // the scan and names the real cause instead of appearing to hang.
    const deadline = Date.now() + this.config.tunnel.portScanTimeoutMs;

    for (let attempt = 0; attempt < span; attempt++) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Unable to establish SSH tunnel within ${this.config.tunnel.portScanTimeoutMs}ms; ` +
            `tried ports ${start}-${end}. The remote stub on ${sshConfig.user}@${sshConfig.host} may not be listening on ${remotePort}.`,
        );
      }

      const localPort = start + ((initialPort - start + attempt) % span);
      const tunnelPID = await this.tryStartTunnel(sshConfig, identityFile, localPort, remotePort);
      if (tunnelPID) {
        return { localPort, tunnelPID };
      }
    }

    throw new Error(`Unable to establish SSH tunnel: no available local port in range ${start}-${end}`);
  }

  private async ensureSpecificOrFallbackTunnel(
    workspaceID: string,
    host: string,
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    remotePort: number,
    preferredLocalPort: number,
  ): Promise<{ localPort: number; tunnelPID?: number }> {
    const tunnelPID = await this.tryStartTunnel(sshConfig, identityFile, preferredLocalPort, remotePort);
    if (tunnelPID) {
      return { localPort: preferredLocalPort, tunnelPID };
    }

    return this.ensureTunnel(workspaceID, host, sshConfig, identityFile, remotePort);
  }

  private async tryStartTunnel(
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    localPort: number,
    remotePort: number,
  ): Promise<number | undefined> {
    if (await this.isPortBound(localPort)) {
      return undefined;
    }

    const args = this.buildTunnelArgs(sshConfig, identityFile, localPort, remotePort);

    const child = spawn("ssh", args, {
      detached: true,
      stdio: "ignore",
    });

    child.unref();

    // ssh with ExitOnForwardFailure=yes exits immediately when the port is taken.
    // Without watching for that, every candidate port cost the full connect
    // timeout, so scanning the range took minutes.
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", () => {
      exited = true;
    });

    try {
      await this.waitForPortReachable(localPort, () => exited);
      return child.pid;
    } catch {
      if (child.pid && !exited) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // Ignore cleanup errors if the process already exited.
        }
      }
      return undefined;
    }
  }

  private buildTunnelArgs(
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    localPort: number,
    remotePort: number,
  ): string[] {
    const args = [
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "NumberOfPasswordPrompts=0",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=10",
      "-L",
      `${localPort}:127.0.0.1:${remotePort}`,
    ];

    if (identityFile && existsSync(identityFile)) {
      args.push("-i", identityFile);
    }

    if (sshConfig.proxyJump) {
      args.push("-J", sshConfig.proxyJump);
    }

    args.push(
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsFile}`,
      "-p",
      String(sshConfig.port || 22),
      `${sshConfig.user}@${sshConfig.host}`,
    );

    return args;
  }

  private async closeTunnel(localPort: number, tunnelPID?: number): Promise<void> {
    if (tunnelPID) {
      try {
        process.kill(tunnelPID, "SIGTERM");
        return;
      } catch {
        // The tracked process is already gone. The port may still be held by an
        // orphan forward, which closeTunnel cannot safely reclaim: it refuses
        // rather than killing a PID it cannot attribute to this tunnel.
      }
    }

    if (await this.isPortReachable(localPort)) {
      throw new Error(`Tunnel on local port ${localPort} is reachable but no tracked PID is available for teardown`);
    }
  }

  /**
   * Reclaim a local port left bound by an ssh forward this plugin started.
   *
   * Only ever signals processes whose command line is exactly the forward this
   * plugin would have created for this host, port pair and user. An orphan
   * forward with no tracked PID still blocks the port, and refusing to reuse it
   * would strand the connection, so it is matched and terminated here. Anything
   * that does not match is left strictly alone.
   */
  private reclaimOrphanTunnel(localPort: number, remotePort: number, host: string, user: string): void {
    // `ps` renders the argument vector space-separated, so the flag and its value
    // appear as "-L 39157:...". The forward is matched with a whitespace-tolerant
    // pattern rather than the argv form, which `ps` never shows literally.
    const forward = new RegExp(`-L\\s+${localPort}:127\\.0\\.0\\.1:${remotePort}(?![\\d.])`);
    let entries: string;
    try {
      entries = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
    } catch {
      return;
    }

    const managedHosts = new Set(
      Object.values(this.config.providers ?? {}).flatMap((provider) => provider.hosts.map((host) => host.ssh.host)),
    );

    for (const line of entries.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const args = match[2];
      if (pid === process.pid) continue;
      if (!/(^|\/)ssh(\s|$)/.test(args) || !forward.test(args)) continue;
      if (!args.includes(`${user}@${host}`)) continue;
      // Only reclaim forwards aimed at a host this plugin is configured to
      // manage, so an unrelated ssh tunnel on the same machine is never touched.
      if (!Array.from(managedHosts).some((managed) => args.includes(`@${managed}`))) continue;

      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already exited.
      }
    }
  }

  private async waitForHealth(localPort: number, token: string): Promise<void> {
    const deadline = Date.now() + this.config.tunnel.healthTimeoutMs;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${localPort}/global/health`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          return;
        }
      } catch {
        // Keep retrying until timeout.
      }

      await this.sleep(300);
    }

    throw new Error(`Remote stub did not become healthy on local port ${localPort}`);
  }

  /**
   * True when something already answers on the local port.
   *
   * Only used to decide whether a candidate tunnel port is spoken for. A bound
   * but silent port (a stale ssh forward to a dead stub) reports false here, so
   * port selection also probes the OS before binding.
   */
  private async isPortReachable(localPort: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/global/health`, { signal: AbortSignal.timeout(500) });
      return response.ok || response.status === 401 || response.status === 403;
    } catch {
      return false;
    }
  }

  /**
   * True when the OS has the local port bound, whether or not anything answers.
   *
   * Checking the listener directly is what makes a stale tunnel detectable: an
   * ssh -L forward whose remote end is gone still holds the local port, so a
   * health probe alone reports it free and the next bind fails.
   *
   * The probe must await the connection attempt. `net.connect` reports success
   * or failure asynchronously, so a synchronous check would answer "bound" for
   * every port, including unused ones.
   */
  private isPortBound(localPort: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: localPort });
      const finish = (bound: boolean) => {
        socket.destroy();
        resolve(bound);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
  }

  private async isHealthReachable(localPort: number, token: string): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/global/health`, {
        signal: AbortSignal.timeout(500),
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async ensureRecoveredBinding(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    if (await this.isHealthReachable(binding.localPort, binding.token)) {
      return binding;
    }
    return this.reconnect(binding, target);
  }

  async validateRecoveredBinding(binding: WorkspaceBinding): Promise<boolean> {
    return this.isHealthReachable(binding.localPort, binding.token);
  }

  async closeRecoveredBinding(binding: WorkspaceBinding): Promise<void> {
    if (binding.tunnelPID) {
      await this.teardown(binding);
      return;
    }

    if (await this.isPortReachable(binding.localPort)) {
      throw new Error(`Recovered tunnel on local port ${binding.localPort} is reachable but has no tracked PID for safe teardown`);
    }
  }

  async isBindingReady(binding: WorkspaceBinding): Promise<boolean> {
    return this.isHealthReachable(binding.localPort, binding.token);
  }

  async reconnectBinding(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async canReachBinding(binding: WorkspaceBinding): Promise<boolean> {
    return this.isHealthReachable(binding.localPort, binding.token);
  }

  async probeBinding(binding: WorkspaceBinding): Promise<boolean> {
    return this.isHealthReachable(binding.localPort, binding.token);
  }

  async ensureReady(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async ensureActive(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async reconnectAfterRestart(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async ensureAfterRestart(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async ensureTargetReady(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async reconnectTargetBinding(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }
  private async waitForPortReachable(localPort: number, aborted?: () => boolean): Promise<void> {
    const deadline = Date.now() + this.config.tunnel.connectTimeoutMs;

    while (Date.now() < deadline) {
      if (await this.isPortReachable(localPort)) {
        return;
      }
      if (aborted?.()) {
        throw new Error(`SSH tunnel on local port ${localPort} exited before accepting connections`);
      }
      await this.sleep(200);
    }

    throw new Error(`SSH tunnel did not become reachable on local port ${localPort}`);
  }

  private async waitForPortReleased(localPort: number): Promise<void> {
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      if (!(await this.isPortBound(localPort))) {
        return;
      }
      await this.sleep(200);
    }

    if (await this.isPortBound(localPort)) {
      throw new Error(
        `Local port ${localPort} is still held after reclaiming its tunnel; refusing to reconnect on a port this plugin cannot attribute`,
      );
    }
  }

  private async waitForPortClosed(localPort: number): Promise<void> {
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      if (!(await this.isPortReachable(localPort))) {
        return;
      }
      await this.sleep(200);
    }

    throw new Error(`SSH tunnel on local port ${localPort} did not close after teardown`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private allocateInitialLocalPort(workspaceID: string, host: string): number {
    const [start, end] = this.config.tunnel.localPortRange;
    const seed = `${workspaceID}:${host}`;
    let hash = 0;
    for (const char of seed) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return start + (hash % (end - start + 1));
  }

  private expandInstallRoot(remoteHome: string): string {
    if (this.config.installRoot.startsWith("~/")) {
      return `${remoteHome}/${this.config.installRoot.slice(2)}`;
    }
    return this.config.installRoot;
  }

  private buildLaunchCommand(installRoot: string, remotePort: number): string {
    return [
      `${installRoot}/bin/opencode-remote-stub`,
      `--listen 127.0.0.1:${remotePort}`,
      `--token-file ${installRoot}/run/stub.token`,
      `--state-dir ${installRoot}/state`,
      `--log-file ${installRoot}/log/stub.log`,
    ].join(" ");
  }

  private buildRemoteStartCommand(installRoot: string, remotePort: number): string {
    // The stub must survive the bootstrap SSH session exiting, so it is started in
    // its own session. setsid does that directly when available; otherwise a
    // Python launcher uses os.setsid via preexec_fn.
    //
    // This deliberately avoids two heredocs chained with `||`. A shell consumes a
    // single heredoc body for the whole compound command, so on a host without
    // python2 the `python` fallback received an empty stream and started nothing,
    // leaving the stub silently not listening.
    const stubArgs = [
      `${installRoot}/bin/opencode-remote-stub`,
      `--listen 127.0.0.1:${remotePort}`,
      `--token-file ${installRoot}/run/stub.token`,
      `--state-dir ${installRoot}/state`,
      `--log-file ${installRoot}/log/stub.log`,
    ].join(" ");

    return [
      `STUB="${stubArgs}"`,
      "if command -v setsid >/dev/null 2>&1; then",
      "  setsid $STUB </dev/null >/dev/null 2>&1 &",
      "else",
      "  PY=$(command -v python3 || command -v python || command -v python2)",
      '  if [ -z "$PY" ]; then echo "no setsid and no python to detach the stub" >&2; exit 1; fi',
      '  "$PY" - <<\'PY\'',
      "import os, subprocess, sys, time",
      'cmd = os.environ["STUB"].split()',
      "proc = subprocess.Popen(cmd, stdin=open('/dev/null','rb'), stdout=open('/dev/null','ab'), stderr=open('/dev/null','ab'), close_fds=True, preexec_fn=os.setsid)",
      "time.sleep(2)",
      "sys.exit(0 if proc.poll() is None else 1)",
      "PY",
      "fi",
      "exit 0",
    ].join("\n");
  }
}
