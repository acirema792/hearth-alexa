import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { seedState, type HearthState } from "./model.js";

/**
 * Durable household state. Everything Hearth knows survives restarts and is shared
 * across every MCP session: the Echo Show in Rosa's kitchen, Daniel's phone, and
 * any other host connected to the same server see the same care record.
 */
export class Store extends EventEmitter {
  private state: HearthState;

  constructor(private readonly path: string | null, seedNow: () => Date) {
    super();
    if (path && existsSync(path)) {
      this.state = JSON.parse(readFileSync(path, "utf8")) as HearthState;
    } else {
      this.state = seedState(seedNow());
      this.flush();
    }
  }

  get(): HearthState {
    return this.state;
  }

  /** Apply a mutation, persist atomically, and tell live listeners what changed. */
  mutate<T>(reason: string, fn: (s: HearthState) => T): T {
    const result = fn(this.state);
    this.flush();
    this.emit("change", { reason, at: new Date().toISOString() });
    return result;
  }

  reset(seedNow: Date): void {
    this.state = seedState(seedNow);
    this.flush();
    this.emit("change", { reason: "reset", at: new Date().toISOString() });
  }

  private flush(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }
}
