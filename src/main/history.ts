import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { HistoryEntry } from "../shared/types";
import type { HistoryRecorder } from "./simulation/controller";
import type { JsonStore } from "./store";

const MAX_ENTRIES = 500;

export class History extends EventEmitter implements HistoryRecorder {
  constructor(private readonly store: JsonStore<HistoryEntry[]>) {
    super();
  }

  list(): HistoryEntry[] {
    return this.store.get();
  }

  begin(entry: Omit<HistoryEntry, "id" | "endedAt" | "outcome">): string {
    const id = randomUUID();
    this.store.update((h) => [{ ...entry, id, endedAt: null, outcome: "running" as const }, ...h].slice(0, MAX_ENTRIES));
    this.emit("change", this.list());
    return id;
  }

  finish(id: string, patch: Partial<HistoryEntry>): void {
    this.store.update((h) =>
      h.map((e) => (e.id === id && e.outcome === "running" ? { ...e, ...patch, point: patch.point ?? e.point } : e)),
    );
    this.emit("change", this.list());
  }

  clear(): void {
    // Keep a running entry so the active simulation still records its outcome.
    this.store.update((h) => h.filter((e) => e.outcome === "running"));
    this.emit("change", this.list());
  }
}
