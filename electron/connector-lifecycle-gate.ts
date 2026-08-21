export class ConnectorLifecycleGate {
  private stopOperation: Promise<void> | null = null;

  get stopping(): boolean {
    return this.stopOperation !== null;
  }

  async waitForStop(): Promise<void> {
    const operation = this.stopOperation;
    if (operation) await operation;
  }

  runStop(operation: () => Promise<void>): Promise<void> {
    if (this.stopOperation) return this.stopOperation;

    const run = Promise.resolve().then(operation);
    const tracked = run.finally(() => {
      if (this.stopOperation === tracked) {
        this.stopOperation = null;
      }
    });
    this.stopOperation = tracked;
    return tracked;
  }
}
