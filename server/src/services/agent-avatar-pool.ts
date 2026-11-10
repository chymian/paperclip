import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { AgentAvatarRequest } from "./agent-avatars.js";

type Job = { request: AgentAvatarRequest; resolve: (png: Buffer) => void; reject: (error: Error) => void };

/**
 * How to start the avatar worker thread. tsx's tsImport is a last resort for
 * TypeScript that no loader can otherwise run: it registers esbuild inside the
 * worker, esbuild's service child then belongs to that thread, and when the
 * idle worker is terminated nobody waits for the child, which stays a zombie
 * (`[esbuild] <defunct>`) of the server process. Compiled servers therefore
 * prefer the worker bundled next to the runtime bundle (`dist-runtime`), then
 * the plain compiled worker when its workspace imports resolve to JavaScript.
 */
export function agentAvatarWorkerLaunch(input: {
  moduleUrl: string;
  execArgv: readonly string[];
  exists: (url: URL) => boolean;
  sharedEntry: () => string;
}): { kind: "file" | "tsx"; url: URL } {
  const loaderInherited = input.execArgv.some((arg) => arg.includes("tsx"));
  if (new URL(input.moduleUrl).pathname.endsWith(".ts")) {
    const url = new URL("./agent-avatar-worker.ts", input.moduleUrl);
    return { kind: loaderInherited ? "file" : "tsx", url };
  }
  const bundled = new URL("../../dist-runtime/agent-avatar-worker.mjs", input.moduleUrl);
  if (input.exists(bundled)) return { kind: "file", url: bundled };
  const compiled = new URL("./agent-avatar-worker.js", input.moduleUrl);
  let sharedIsTypeScript = true;
  try { sharedIsTypeScript = /\.[cm]?tsx?$/.test(new URL(input.sharedEntry()).pathname); } catch { /* keep the tsx fallback */ }
  return { kind: loaderInherited || !sharedIsTypeScript ? "file" : "tsx", url: compiled };
}
/** Lazy, bounded workers isolate geometry/rasterization from the API event loop. */
export function createAgentAvatarPool(concurrency = 2, maxQueue = 64) {
  const queue: Job[] = [];
  let active = 0;
  const idle: Worker[] = [];
  const timers = new Map<Worker, ReturnType<typeof setTimeout>>();
  const workers = new Set<Worker>();
  let closed = false;
  function spawn() {
    const launch = agentAvatarWorkerLaunch({
      moduleUrl: import.meta.url,
      execArgv: process.execArgv,
      exists: (url) => existsSync(url),
      sharedEntry: () => import.meta.resolve("@paperclipai/shared"),
    });
    const worker = launch.kind === "tsx"
      ? new Worker(`import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))}).then(({tsImport}) => tsImport(${JSON.stringify(launch.url.href)}, ${JSON.stringify(import.meta.url)}));`, { eval: true })
      : new Worker(launch.url);
    workers.add(worker);
    // Idle worker failures must not become uncaught events or leave dead slots.
    worker.on("error", () => {});
    worker.on("exit", () => {
      const index = idle.indexOf(worker);
      if (index >= 0) idle.splice(index, 1);
      clearTimeout(timers.get(worker)); timers.delete(worker); workers.delete(worker);
    });
    return worker;
  }
  function drain() {
    while (!closed && active < concurrency && queue.length) {
      const job = queue.shift()!;
      let worker: Worker;
      try { worker = idle.pop() ?? spawn(); }
      catch (error) { job.reject(error instanceof Error ? error : new Error(String(error))); continue; }
      clearTimeout(timers.get(worker)); timers.delete(worker);
      worker.ref(); active++;
      let finished = false;
      const timeout = setTimeout(() => finish(new Error("Avatar rendering timed out")), 15_000);
      const onError = (error: Error) => finish(error);
      const onExit = () => finish(new Error("Avatar worker exited"));
      const onMessage = (result: { png?: Uint8Array; error?: string }) => {
        finish(result.png ? undefined : new Error(result.error ?? "Avatar rendering failed"), result.png);
      };
      function finish(error?: Error, png?: Uint8Array) {
        if (finished) return;
        finished = true; clearTimeout(timeout); active--;
        worker.off("message", onMessage); worker.off("error", onError); worker.off("exit", onExit);
        if (error || closed) {
          workers.delete(worker); void worker.terminate();
          job.reject(error ?? new Error("Avatar pool closed"));
        } else {
          job.resolve(Buffer.from(png!));
          worker.unref(); idle.push(worker);
          const timer = setTimeout(() => {
            const index = idle.indexOf(worker);
            if (index >= 0) idle.splice(index, 1);
            timers.delete(worker); workers.delete(worker); void worker.terminate();
          }, 30_000);
          timer.unref(); timers.set(worker, timer);
        }
        drain();
      }
      worker.once("message", onMessage); worker.once("error", onError); worker.once("exit", onExit);
      try { worker.postMessage(job.request); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    }
  }
  return {
    render(request: AgentAvatarRequest): Promise<Buffer> {
      if (closed || queue.length >= maxQueue) return Promise.reject(new Error("Avatar renderer is busy"));
      return new Promise((resolve, reject) => { queue.push({ request, resolve, reject }); drain(); });
    },
    async close() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error("Avatar pool closed"));
      for (const timer of timers.values()) clearTimeout(timer);
      await Promise.all([...workers].map(worker => worker.terminate()));
    },
  };
}
