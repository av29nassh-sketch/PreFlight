export type WatchEventBatchHandler = (filePaths: string[]) => void | Promise<void>;

export interface DebouncedWatchEventQueueOptions {
  debounceMs?: number;
  onFlush: WatchEventBatchHandler;
}

export class DebouncedWatchEventQueue {
  private readonly debounceMs: number;
  private readonly onFlush: WatchEventBatchHandler;
  private readonly pendingFilePaths = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: DebouncedWatchEventQueueOptions) {
    this.debounceMs = options.debounceMs ?? 400;
    this.onFlush = options.onFlush;
  }

  enqueue(filePath: string): void {
    this.pendingFilePaths.add(filePath);

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.pendingFilePaths.size === 0) {
      return;
    }

    const filePaths = Array.from(this.pendingFilePaths).sort();
    this.pendingFilePaths.clear();
    await this.onFlush(filePaths);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.pendingFilePaths.clear();
  }
}
