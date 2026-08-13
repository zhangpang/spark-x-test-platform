export type ExecutorActionLevel = "read" | "write" | "dangerous";

export interface ExecutorDescriptor {
  readonly key: string;
  readonly actionLevel: ExecutorActionLevel;
  readonly defaultTimeoutMs: number;
}

export class ExecutorRegistry {
  readonly #descriptors = new Map<string, ExecutorDescriptor>();

  register(descriptor: ExecutorDescriptor): void {
    if (this.#descriptors.has(descriptor.key)) {
      throw new Error(`Executor already registered: ${descriptor.key}`);
    }
    this.#descriptors.set(descriptor.key, Object.freeze({ ...descriptor }));
  }

  get(key: string): ExecutorDescriptor | undefined {
    return this.#descriptors.get(key);
  }

  list(): readonly ExecutorDescriptor[] {
    return [...this.#descriptors.values()].sort((left, right) => left.key.localeCompare(right.key));
  }
}
