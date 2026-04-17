import { useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Listens for "stream-progress" events emitted by Rust streaming commands.
 * Returns the current progress (0-100) while active, null when idle.
 *
 * Usage:
 *   const { progress, startProgress } = useStreamProgress();
 *   const stop = await startProgress();
 *   try { await invoke(...); } finally { stop(); }
 */
export function useStreamProgress() {
  const [progress, setProgress] = useState<number | null>(null);

  const startProgress = useCallback(async () => {
    setProgress(0);
    const unlisten = await listen<{ percent: number }>("stream-progress", (e) => {
      setProgress(e.payload.percent);
    });
    return () => {
      unlisten();
      setProgress(null);
    };
  }, []);

  return { progress, startProgress };
}
