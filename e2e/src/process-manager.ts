import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import { sleep } from "./polling.ts";

export interface ProcessOptions {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  ipc?: boolean;
}

export class ManagedProcess {
  readonly name: string;
  private readonly child: ChildProcess;
  private readonly outputChunks: string[] = [];
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;

  constructor(options: ProcessOptions) {
    this.name = options.name;
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.ipc
        ? ["ignore", "pipe", "pipe", "ipc"]
        : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.capture(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => this.capture(chunk));
    this.child.once("error", (error) => this.capture(String(error)));
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
    });
  }

  assertRunning(): void {
    if (this.exited) {
      throw new Error(
        `${this.name} exited code=${this.exitCode} signal=${this.exitSignal}\n${this.output()}`,
      );
    }
  }

  output(): string {
    return this.outputChunks.join("").slice(-20_000);
  }

  async stop(graceMs = 10_000): Promise<void> {
    if (this.exited) {
      return;
    }
    if (this.child.connected) {
      this.child.send({ type: "msh-graceful-shutdown" });
    } else {
      this.child.kill("SIGTERM");
    }
    const deadline = Date.now() + graceMs;
    while (!this.exited && Date.now() < deadline) {
      await sleep(50);
    }
    if (!this.exited) {
      this.child.kill("SIGKILL");
      const forceDeadline = Date.now() + 2_000;
      while (!this.exited && Date.now() < forceDeadline) {
        await sleep(25);
      }
    }
  }

  async kill(): Promise<void> {
    if (this.exited) {
      return;
    }
    this.child.kill("SIGKILL");
    const deadline = Date.now() + 2_000;
    while (!this.exited && Date.now() < deadline) {
      await sleep(25);
    }
  }

  private capture(chunk: Buffer | string): void {
    this.outputChunks.push(String(chunk));
    let length = this.outputChunks.reduce(
      (total, current) => total + current.length,
      0,
    );
    while (length > 40_000 && this.outputChunks.length > 1) {
      length -= this.outputChunks.shift()?.length ?? 0;
    }
  }
}

export function getFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a local TCP port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
