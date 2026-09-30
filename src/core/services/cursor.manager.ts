import { FlatStoreMap } from '../../utils/flat-store-map';
import {
  JsonDataCursor,
  createJsonPathPlan,
  type JsonPathPlan,
} from '@adsq/jsnq/data-engine';

type PathPlan = JsonPathPlan;

/**
 * CursorManager - optimized path traversal with caching.
 * Uses FlatStoreMap for better performance than plain Record.
 */
export class CursorManager {
  private readonly pathSetPlanCache = new FlatStoreMap<PathPlan>();
  private readonly cursor = new JsonDataCursor();

  applyPathPlan(normalizedPath: string): PathPlan {
    return this.pathSetPlanCache.getOrCreate(normalizedPath, createJsonPathPlan);
  }

  prefetch(path: string, node: Record<string, unknown> | null): void {
    this.cursor.prefetch(path, node);
  }

  mutateNode(root: Record<string, unknown>, plan: PathPlan, normalizedPath: string, value: unknown): unknown {
    const effectivePlan = plan.path === normalizedPath ? plan : createJsonPathPlan(normalizedPath);
    const result = this.cursor.writeWithPlan(root, effectivePlan, value);
    return result.previous;
  }

  invalidateCache(normalizedPath: string): void {
    this.pathSetPlanCache.deleteByPrefix(normalizedPath);
  }

  invalidateForDeletion(normalizedPath: string): void {
    this.cursor.invalidateForDeletion(normalizedPath);
  }

  /**
   * Clear all caches (useful for testing or memory management).
   */
  clearCaches(): void {
    this.pathSetPlanCache.clear();
    this.cursor.clear();
  }
}
