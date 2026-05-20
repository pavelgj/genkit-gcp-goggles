interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttlMs: number;
}

export const CacheTTL = {
  METRICS: 60_000,
  TRACE_LIST: 30_000,
  TRACE_DETAIL: 300_000,
  TRACE_LOGS: 600_000,   // 10 min — logs for past traces never change
  PROJECTS: 600_000,
} as const;

class LRUCache {
  private cache: Map<string, CacheEntry<unknown>>;
  private readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.cache.delete(key);
    while (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { data, timestamp: Date.now(), ttlMs });
  }

  async getOrFetch<T>(key: string, ttlMs: number, fetchFn: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const data = await fetchFn();
    this.set(key, data, ttlMs);
    return data;
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  static key(prefix: string, params: Record<string, unknown>): string {
    const sortedParams = Object.keys(params)
      .sort()
      .map((k) => `${k}=${JSON.stringify(params[k])}`)
      .join('&');
    return `${prefix}:${sortedParams}`;
  }
}

export const cache = new LRUCache(1000);
