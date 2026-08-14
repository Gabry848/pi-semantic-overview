import type { SemanticGraph } from "./types.js";

export class GraphStore {
  private listeners = new Set<(graph: SemanticGraph) => void>();
  constructor(private graph: SemanticGraph) {}
  get(): SemanticGraph { return this.graph; }
  set(graph: SemanticGraph): void {
    this.graph = graph;
    for (const listener of [...this.listeners]) listener(graph);
  }
  subscribe(listener: (graph: SemanticGraph) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  get listenerCount(): number { return this.listeners.size; }
}
