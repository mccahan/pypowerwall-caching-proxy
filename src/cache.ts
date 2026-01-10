import axios, { AxiosError } from 'axios';
import { CacheEntry, PendingRequest, UrlConfig } from './types';
import { ConfigLoader } from './config';

export class CacheManager {
  private cache: Map<string, CacheEntry> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private staleUpdateQueue: Set<string> = new Set();
  private urlConfigs: Map<string, UrlConfig> = new Map();

  constructor() {
    const config = ConfigLoader.get();
    // Build URL config map for quick lookup
    config.urlConfigs.forEach(urlConfig => {
      this.urlConfigs.set(urlConfig.path, urlConfig);
    });
  }

  private getUrlConfig(path: string): UrlConfig | undefined {
    return this.urlConfigs.get(path);
  }

  private getCacheTTL(path: string): number {
    const urlConfig = this.getUrlConfig(path);
    if (urlConfig?.cacheTTL !== undefined) {
      return urlConfig.cacheTTL * 1000; // Convert to milliseconds
    }
    return ConfigLoader.get().cache.defaultTTL * 1000;
  }

  private getStaleTime(path: string): number {
    const urlConfig = this.getUrlConfig(path);
    if (urlConfig?.staleTime !== undefined) {
      return urlConfig.staleTime * 1000; // Convert to milliseconds
    }
    return ConfigLoader.get().cache.defaultStaleTime * 1000;
  }

  private isCacheValid(entry: CacheEntry): boolean {
    const now = Date.now();
    return (now - entry.timestamp) < entry.ttl;
  }

  private isCacheStale(entry: CacheEntry): boolean {
    const now = Date.now();
    return (now - entry.timestamp) >= entry.staleTime;
  }

  async get(path: string, fullUrl: string): Promise<CacheEntry | null> {
    const cached = this.cache.get(path);
    
    if (cached && this.isCacheValid(cached)) {
      // If stale but valid, queue for background update
      if (this.isCacheStale(cached) && !this.staleUpdateQueue.has(path)) {
        this.queueStaleUpdate(path, fullUrl);
      }
      return cached;
    }

    return null;
  }

  set(path: string, data: any, headers: Record<string, string>): void {
    const entry: CacheEntry = {
      data,
      headers,
      timestamp: Date.now(),
      ttl: this.getCacheTTL(path),
      staleTime: this.getStaleTime(path)
    };
    this.cache.set(path, entry);
  }

  private queueStaleUpdate(path: string, fullUrl: string): void {
    this.staleUpdateQueue.add(path);
    
    // Perform async update
    setImmediate(async () => {
      try {
        await this.fetchFromBackend(path, fullUrl);
      } catch (error) {
        console.error(`Error updating stale cache for ${path}:`, error);
      } finally {
        this.staleUpdateQueue.delete(path);
      }
    });
  }

  async fetchFromBackend(path: string, fullUrl: string): Promise<CacheEntry> {
    // Check if there's already a pending request for this URL
    const pending = this.pendingRequests.get(path);
    if (pending) {
      return pending.promise;
    }

    // Create new request
    const config = ConfigLoader.get();
    const backendUrl = `${config.backend.url}${fullUrl}`;

    const requestPromise = (async (): Promise<CacheEntry> => {
      try {
        const response = await axios.get(backendUrl, {
          timeout: 30000,
          validateStatus: (status) => status < 500 // Accept all non-5xx responses
        });

        const headers: Record<string, string> = {};
        Object.keys(response.headers).forEach(key => {
          headers[key] = String(response.headers[key]);
        });

        const entry: CacheEntry = {
          data: response.data,
          headers,
          timestamp: Date.now(),
          ttl: this.getCacheTTL(path),
          staleTime: this.getStaleTime(path)
        };

        this.cache.set(path, entry);
        return entry;
      } catch (error) {
        const axiosError = error as AxiosError;
        console.error(`Error fetching from backend ${backendUrl}:`, axiosError.message);
        throw error;
      } finally {
        this.pendingRequests.delete(path);
      }
    })();

    this.pendingRequests.set(path, {
      promise: requestPromise,
      timestamp: Date.now()
    });

    return requestPromise;
  }

  async getOrFetch(path: string, fullUrl: string, timeout?: number): Promise<{ entry: CacheEntry | null; fromCache: boolean }> {
    // Check cache first
    const cached = await this.get(path, fullUrl);
    if (cached) {
      return { entry: cached, fromCache: true };
    }

    // No valid cache, fetch from backend
    const slowTimeout = timeout || ConfigLoader.get().cache.slowRequestTimeout;
    
    try {
      const entry = await Promise.race([
        this.fetchFromBackend(path, fullUrl),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), slowTimeout))
      ]);

      if (entry === null) {
        // Request took too long, check if we have stale cache
        const staleCache = this.cache.get(path);
        if (staleCache) {
          console.log(`Slow request for ${path}, returning stale cache`);
          return { entry: staleCache, fromCache: true };
        }
        
        // No stale cache available, wait for the actual request
        console.log(`Slow request for ${path}, no stale cache available, waiting...`);
        const actualEntry = await this.fetchFromBackend(path, fullUrl);
        return { entry: actualEntry, fromCache: false };
      }

      return { entry, fromCache: false };
    } catch (error) {
      // On error, try to return stale cache if available
      const staleCache = this.cache.get(path);
      if (staleCache) {
        console.log(`Error fetching ${path}, returning stale cache`);
        return { entry: staleCache, fromCache: true };
      }
      throw error;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }
}
