import { CacheEntry, PendingRequest, UrlConfig } from './types';
import { ConfigLoader } from './config';
import { PluginManager } from './plugins';
import { Logger } from './logger';
import { ConnectionManager } from './connectionManager';

export class CacheManager {
  private cache: Map<string, CacheEntry> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private staleUpdateQueue: Set<string> = new Set();
  private urlConfigs: Map<string, UrlConfig> = new Map();
  // Add a new Map to track cache hits and misses
  private cacheStats: Map<string, { hits: number; misses: number }> = new Map();
  private pluginManager: PluginManager;
  private connectionManager: ConnectionManager;
  
  // Maximum number of request durations to track per URL
  private readonly MAX_TRACKED_DURATIONS = 25;

  constructor(pluginManager: PluginManager, connectionManager: ConnectionManager) {
    const config = ConfigLoader.get();
    // Build URL config map for quick lookup
    config.urlConfigs.forEach(urlConfig => {
      this.urlConfigs.set(urlConfig.path, urlConfig);
    });
    // Initialize cacheStats
    this.cacheStats = new Map();
    this.pluginManager = pluginManager;
    this.connectionManager = connectionManager;
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

  async get(fullUrl: string): Promise<CacheEntry | null> {
    const cached = this.cache.get(fullUrl);

    if (cached && this.isCacheValid(cached)) {
      // If stale but valid, queue for background update
      if (this.isCacheStale(cached) && !this.staleUpdateQueue.has(fullUrl)) {
        this.queueStaleUpdate(fullUrl);
      }
      // Increment hit counter
      const stats = this.cacheStats.get(fullUrl) || { hits: 0, misses: 0 };
      stats.hits += 1;
      this.cacheStats.set(fullUrl, stats);
      return cached;
    }

    // Increment miss counter
    const stats = this.cacheStats.get(fullUrl) || { hits: 0, misses: 0 };
    stats.misses += 1;
    this.cacheStats.set(fullUrl, stats);

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

  private queueStaleUpdate(fullUrl: string): void {
    this.staleUpdateQueue.add(fullUrl);

    // Perform async update
    setImmediate(async () => {
      try {
        await this.fetchFromBackend(fullUrl);
      } catch (error) {
        Logger.error(`Error updating stale cache for ${fullUrl}:`, error);
      } finally {
        this.staleUpdateQueue.delete(fullUrl);
      }
    });
  }

  private updateRequestDurations(fullUrl: string, durationMs: number): number[] {
    const existingEntry = this.cache.get(fullUrl);
    const existingDurations = existingEntry?.requestDurations || [];
    
    // Keep only the last N durations, add the new one
    const updatedDurations = [...existingDurations, durationMs].slice(-this.MAX_TRACKED_DURATIONS);
    
    return updatedDurations;
  }

  async fetchFromBackend(fullUrl: string): Promise<CacheEntry> {
    // Check if there's already a pending request for this URL
    const pending = this.pendingRequests.get(fullUrl);
    if (pending) {
      return pending.promise;
    }

    // Create new request
    const requestPromise = (async (): Promise<CacheEntry> => {
      const requestStartTime = Date.now();
      try {
        const result = await this.connectionManager.fetch(fullUrl);
        const requestDuration = Date.now() - requestStartTime;

        // Validate the response before caching using plugin manager
        if (!this.pluginManager.shouldCache(fullUrl, result.data)) {
          Logger.debug(`Response validation failed for ${fullUrl}, not caching`);
          throw new Error(`Invalid response for ${fullUrl}: validation failed`);
        }

        // Update request durations for this URL
        const requestDurations = this.updateRequestDurations(fullUrl, requestDuration);

        const entry: CacheEntry = {
          data: result.data,
          headers: result.headers,
          timestamp: Date.now(),
          ttl: this.getCacheTTL(fullUrl),
          staleTime: this.getStaleTime(fullUrl),
          requestDurations
        };

        this.cache.set(fullUrl, entry);
        
        // Notify plugins about the response (fire and forget)
        this.pluginManager.notifyResponse(fullUrl, result.data);
        
        return entry;
      } catch (error) {
        // Re-throw error so it propagates to waiting callers
        throw error;
      } finally {
        this.pendingRequests.delete(fullUrl);
      }
    })();

    this.pendingRequests.set(fullUrl, {
      promise: requestPromise,
      timestamp: Date.now()
    });

    return requestPromise;
  }

  async getOrFetch(fullUrl: string, timeout?: number): Promise<{ entry: CacheEntry | null; fromCache: boolean }> {
    // Check cache first
    const cached = await this.get(fullUrl);
    if (cached) {
      return { entry: cached, fromCache: true };
    }

    // No valid cache, fetch from backend
    const slowTimeout = timeout || ConfigLoader.get().cache.slowRequestTimeout;

    try {
      const entry = await Promise.race([
        this.fetchFromBackend(fullUrl),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), slowTimeout))
      ]);

      if (entry === null) {
        // Request took too long, check if we have stale cache
        const staleCache = this.cache.get(fullUrl);
        if (staleCache) {
          Logger.debug(`Slow request for ${fullUrl}, returning stale cache`);
          return { entry: staleCache, fromCache: true };
        }

        // No stale cache available, wait for the actual request
        Logger.debug(`Slow request for ${fullUrl}, no stale cache available, waiting...`);
        const actualEntry = await this.fetchFromBackend(fullUrl);
        return { entry: actualEntry, fromCache: false };
      }

      return { entry, fromCache: false };
    } catch (error) {
      // On error, try to return stale cache if available
      const staleCache = this.cache.get(fullUrl);
      if (staleCache) {
        Logger.debug(`Error fetching ${fullUrl}, returning stale cache`);
        return { entry: staleCache, fromCache: true };
      }
      throw error;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  isEndpointInBackoff(fullUrl: string): boolean {
    return this.connectionManager.isEndpointInBackoff(fullUrl);
  }

  getQueueStats(): {
    queueLength: number;
    activeRequestCount: number;
    maxConcurrentRequests: number;
    queuedUrls: string[];
    activeUrls: Array<{ url: string; startTime: number; runtimeMs: number }>;
    recentlyCompleted: Array<{
      fullUrl: string;
      startTime: number;
      endTime: number;
      runtimeMs: number;
      success: boolean;
    }>;
  } {
    return this.connectionManager.getQueueStats();
  }

  getCacheStats(): { 
    size: number; 
    keys: Record<string, { lastFetchTime: number; size: number; hits: number; misses: number; avgResponseTime?: number; maxResponseTime?: number }>;
    errorRate: number;
    errorRateByPath: Record<string, number>;
    backoffStates: Record<string, { consecutiveErrors: number; backoffDelayMs: number; nextRetryTime: number }>;
  } {
    const backoffStates = this.connectionManager.getBackoffStates();
    const { errorRate, errorRateByPath } = this.connectionManager.getErrorRateStats();
    
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.entries()).reduce((acc, [key, entry]) => {
        const stats = this.cacheStats.get(key) || { hits: 0, misses: 0 };
        
        // Calculate average and max response time from the tracked durations
        let avgResponseTime: number | undefined;
        let maxResponseTime: number | undefined;
        if (entry.requestDurations && entry.requestDurations.length > 0) {
          const sum = entry.requestDurations.reduce((total, duration) => total + duration, 0);
          avgResponseTime = sum / entry.requestDurations.length;
          maxResponseTime = Math.max(...entry.requestDurations);
        }
        
        acc[key] = {
          lastFetchTime: entry.timestamp,
          size: JSON.stringify(entry.data).length,
          hits: stats.hits,
          misses: stats.misses,
          avgResponseTime,
          maxResponseTime
        };
        return acc;
      }, {} as Record<string, { lastFetchTime: number; size: number; hits: number; misses: number; avgResponseTime?: number; maxResponseTime?: number }>),
      errorRate,
      errorRateByPath,
      backoffStates
    };
  }
}
