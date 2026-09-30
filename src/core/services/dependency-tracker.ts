import { PathUtils } from '../../utils/path-utils';

export class DependencyTracker {
  private activeCollector: Set<string> | null = null;
  private trackReads = true;

  startCollect(): void {
    this.activeCollector = new Set<string>();
  }

  stopCollect(): Set<string> | null {
    const collector = this.activeCollector;
    this.activeCollector = null;
    return collector;
  }

  registerRead(path: string): void {
    if (this.isCollecting()) this.activeCollector!.add(PathUtils.normalizePath(path));
  }

  registerReadNormalized(path: string): void {
    if (this.isCollecting()) this.activeCollector!.add(path);
  }

  setTrackReads(enabled: boolean): void {
    this.trackReads = !!enabled;
  }

  getTrackReads(): boolean {
    return this.trackReads;
  }

  isCollecting(): boolean {
    return this.trackReads && this.activeCollector !== null;
  }

  trackProjection<TOut>(project: () => TOut): { value: TOut; deps: string[] } {
    this.startCollect();
    let value: TOut;
    let collected: Set<string> | null;
    try {
      value = project();
    } finally {
      collected = this.stopCollect();
    }
    return { value, deps: collected ? Array.from(collected) : [] };
  }
}
