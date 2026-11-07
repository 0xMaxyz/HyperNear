// In-process event log for the guard and decision feed (served as SSE by server.ts).

export interface AgentEvent {
  id: number;
  at: number;
  type: string;
  data: Record<string, unknown>;
}

export class EventBus {
  readonly #recent: AgentEvent[] = [];
  readonly #subs = new Set<(e: AgentEvent) => void>();
  #next = 1;

  readonly keep: number;
  constructor(keep = 200) {
    this.keep = keep;
  }

  emit(type: string, data: Record<string, unknown>): AgentEvent {
    const e = { id: this.#next++, at: Date.now(), type, data };
    this.#recent.push(e);
    if (this.#recent.length > this.keep) this.#recent.shift();
    for (const f of this.#subs) f(e);
    return e;
  }

  /** Events after `lastId` (SSE Last-Event-ID replay). */
  since(lastId = 0): AgentEvent[] {
    return this.#recent.filter((e) => e.id > lastId);
  }

  subscribe(f: (e: AgentEvent) => void): () => void {
    this.#subs.add(f);
    return () => this.#subs.delete(f);
  }
}
