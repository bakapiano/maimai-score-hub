import type { DxnetExecutionLane } from "@maimai-score-hub/shared";

export interface ActiveExecution {
  deliveryId: string;
  controller: AbortController;
  lane: DxnetExecutionLane | null;
  executionRegistered: boolean;
}

export class ActiveExecutionRegistry {
  private readonly executions = new Map<string, Set<ActiveExecution>>();

  begin(deliveryId: string, lane: DxnetExecutionLane | null): ActiveExecution {
    const execution: ActiveExecution = {
      deliveryId,
      controller: new AbortController(),
      lane,
      executionRegistered: false,
    };
    const current = this.executions.get(deliveryId) ?? new Set();
    current.add(execution);
    this.executions.set(deliveryId, current);
    return execution;
  }

  end(execution: ActiveExecution): void {
    const current = this.executions.get(execution.deliveryId);
    current?.delete(execution);
    if (current?.size === 0) {
      this.executions.delete(execution.deliveryId);
    }
  }

  abort(deliveryId: string, reason: Error): void {
    for (const execution of this.executions.get(deliveryId) ?? []) {
      execution.controller.abort(reason);
    }
  }

  abortWhere(
    predicate: (execution: ActiveExecution) => boolean,
    createReason: () => Error,
  ): void {
    for (const execution of this.all()) {
      if (predicate(execution)) {
        execution.controller.abort(createReason());
      }
    }
  }

  async waitForDrain(
    timeoutMs: number,
    predicate: (execution: ActiveExecution) => boolean,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      Date.now() < deadline &&
      this.all().some(predicate)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private all(): ActiveExecution[] {
    return [...this.executions.values()].flatMap((entries) => [...entries]);
  }
}

export class ShutdownRequeueError extends Error {
  constructor() {
    super("worker shutdown requested requeue");
    this.name = "ShutdownRequeueError";
  }
}
