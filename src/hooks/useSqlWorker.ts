/**
 * Singleton Web Worker for SQL processing.
 * The worker is created once and reused across all page navigations.
 */

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/sqlWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data as { id: number; result?: unknown; error?: string };
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error !== undefined) p.reject(new Error(error));
      else p.resolve(result);
    };
  }
  return worker;
}

export function useSqlWorker() {
  function call<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      getWorker().postMessage({ id, type, ...payload });
    });
  }
  return { call };
}
