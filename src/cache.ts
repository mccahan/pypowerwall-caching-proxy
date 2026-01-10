import axios, { AxiosError } from 'axios';
import { CacheEntry, PendingRequest, UrlConfig, BackoffState, ErrorEvent, BackoffError } from './types';
import { ConfigLoader } from './config';
import { PluginManager } from './plugins';
import { Logger } from './logger';

export class CacheManager {
  private cache: Map<string, CacheEntry> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private staleUpdateQueue: Set<string> = new Set();
  private urlConfigs: Map<string, UrlConfig> = new Map();
  // Add a new Map to track cache hits and misses
  private cacheStats: Map<string, { hits: number; misses: number }> = new Map();
  private pluginManager: PluginManager;
  
  // Backoff state tracking
  private backoffStates: Map<string, BackoffState> = new Map();
  private readonly INITIAL_BACKOFF_DELAY = 5000; // 5 seconds
  private readonly MAX_BACKOFF_DELAY = 300000; // 5 minutes
  private readonly BACKOFF_MULTIPLIER = 2;
  
  // Error rate tracking (10-minute window)
  private errorEvents: ErrorEvent[] = [];
  private readonly ERROR_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  private readonly ERROR_WINDOW_MINUTES = 10;

  constructor(pluginManager: PluginManager) {
    const config = ConfigLoader.get();
    // Build URL config map for quick lookup
    config.urlConfigs.forEach(urlConfig => {
      this.urlConfigs.set(urlConfig.path, urlConfig);
    });
    // Initialize cacheStats
    this.cacheStats = new Map();
    this.pluginManager = pluginManager;
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

  private isInBackoff(path: string): boolean {
    const backoffState = this.backoffStates.get(path);
    if (!backoffState) {
      return false;
    }
    return Date.now() < backoffState.nextRetryTime;
  }

  private getBackoffDelay(path: string): number {
    const backoffState = this.backoffStates.get(path);
    if (!backoffState) {
      return 0;
    }
    return Math.max(0, backoffState.nextRetryTime - Date.now());
  }

  private recordError(path: string): void {
    const now = Date.now();
    
    // Add error event for rate tracking
    this.errorEvents.push({ timestamp: now, path });
    
    // Clean up old error events (older than 10 minutes)
    this.errorEvents = this.errorEvents.filter(
      event => now - event.timestamp < this.ERROR_WINDOW_MS
    );
    
    // Update backoff state
    const backoffState = this.backoffStates.get(path) || {
      consecutiveErrors: 0,
      backoffDelay: 0,
      nextRetryTime: 0,
      lastErrorTime: 0
    };
    
    backoffState.consecutiveErrors++;
    backoffState.lastErrorTime = now;
    
    // Calculate new backoff delay with exponential backoff
    if (backoffState.consecutiveErrors === 1) {
      backoffState.backoffDelay = this.INITIAL_BACKOFF_DELAY;
    } else {
      backoffState.backoffDelay = Math.min(
        backoffState.backoffDelay * this.BACKOFF_MULTIPLIER,
        this.MAX_BACKOFF_DELAY
      );
    }
    
    backoffState.nextRetryTime = now + backoffState.backoffDelay;
    
    this.backoffStates.set(path, backoffState);
    
    Logger.debug(
      `Backoff for ${path}: ${backoffState.consecutiveErrors} consecutive errors, ` +
      `next retry in ${backoffState.backoffDelay}ms`
    );
  }

  private recordSuccess(path: string): void {
    const backoffState = this.backoffStates.get(path);
    if (backoffState && backoffState.consecutiveErrors > 0) {
      Logger.debug(
        `Request succeeded for ${path}, resetting backoff ` +
        `(was ${backoffState.consecutiveErrors} consecutive errors)`
      );
      this.backoffStates.delete(path);
    }
  }

  private getErrorRate(): number {
    const now = Date.now();
    const recentErrors = this.errorEvents.filter(
      event => now - event.timestamp < this.ERROR_WINDOW_MS
    );
    // Return errors per minute over the error window
    return (recentErrors.length / this.ERROR_WINDOW_MINUTES);
  }

  private getErrorRateByPath(): Record<string, number> {
    const now = Date.now();
    const recentErrors = this.errorEvents.filter(
      event => now - event.timestamp < this.ERROR_WINDOW_MS
    );
    
    const errorCounts: Record<string, number> = {};
    recentErrors.forEach(event => {
      errorCounts[event.path] = (errorCounts[event.path] || 0) + 1;
    });
    
    // Convert counts to rate (errors per minute)
    const errorRates: Record<string, number> = {};
    Object.keys(errorCounts).forEach(path => {
      errorRates[path] = errorCounts[path] / this.ERROR_WINDOW_MINUTES;
    });
    
    return errorRates;
  }

  private getErrorStats(): { errorRate: number; errorRateByPath: Record<string, number> } {
    const now = Date.now();
    const recentErrors = this.errorEvents.filter(
      event => now - event.timestamp < this.ERROR_WINDOW_MS
    );
    
    // Calculate overall rate
    const errorRate = recentErrors.length / this.ERROR_WINDOW_MINUTES;
    
    // Calculate per-path rates
    const errorCounts: Record<string, number> = {};
    recentErrors.forEach(event => {
      errorCounts[event.path] = (errorCounts[event.path] || 0) + 1;
    });
    
    const errorRateByPath: Record<string, number> = {};
    Object.keys(errorCounts).forEach(path => {
      errorRateByPath[path] = errorCounts[path] / this.ERROR_WINDOW_MINUTES;
    });
    
    return { errorRate, errorRateByPath };
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

  async fetchFromBackend(fullUrl: string): Promise<CacheEntry> {
    // Check if endpoint is in backoff
    if (this.isInBackoff(fullUrl)) {
      const delay = this.getBackoffDelay(fullUrl);
      const backoffState = this.backoffStates.get(fullUrl);
      Logger.debug(
        `Endpoint ${fullUrl} is in backoff for ${delay}ms ` +
        `(${backoffState?.consecutiveErrors} consecutive errors)`
      );
      
      // Return cache if available and valid during backoff
      // Note: We intentionally serve stale cache during backoff as long as it's within TTL,
      // since the backend is failing and any data is better than none
      const cachedEntry = this.cache.get(fullUrl);
      if (cachedEntry && this.isCacheValid(cachedEntry)) {
        Logger.debug(`Returning cached data for ${fullUrl} during backoff`);
        return cachedEntry;
      }
      
      // No valid cache, throw BackoffError
      throw new BackoffError(
        fullUrl,
        delay,
        backoffState?.consecutiveErrors || 0
      );
    }
    
    // Check if there's already a pending request for this URL
    const pending = this.pendingRequests.get(fullUrl);
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
          ttl: this.getCacheTTL(fullUrl),
          staleTime: this.getStaleTime(fullUrl)
        };

        this.cache.set(fullUrl, entry);
        
        // Record successful request (resets backoff)
        this.recordSuccess(fullUrl);
        
        // Notify plugins about the response (fire and forget)
        this.pluginManager.notifyResponse(fullUrl, response.data);
        
        return entry;
      } catch (error) {
        const axiosError = error as AxiosError;
        Logger.error(`Error fetching from backend ${backendUrl}:`, axiosError.message);
        
        // Record error for backoff tracking
        this.recordError(fullUrl);
        
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
    return this.isInBackoff(fullUrl);
  }

  getCacheStats(): { 
    size: number; 
    keys: Record<string, { lastFetchTime: number; size: number; hits: number; misses: number }>;
    errorRate: number;
    errorRateByPath: Record<string, number>;
    backoffStates: Record<string, { consecutiveErrors: number; backoffDelayMs: number; nextRetryTime: number }>;
  } {
    const backoffStatesObj: Record<string, { consecutiveErrors: number; backoffDelayMs: number; nextRetryTime: number }> = {};
    this.backoffStates.forEach((state, path) => {
      backoffStatesObj[path] = {
        consecutiveErrors: state.consecutiveErrors,
        backoffDelayMs: state.backoffDelay,
        nextRetryTime: state.nextRetryTime
      };
    });
    
    const { errorRate, errorRateByPath } = this.getErrorStats();
    
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.entries()).reduce((acc, [key, entry]) => {
        const stats = this.cacheStats.get(key) || { hits: 0, misses: 0 };
        acc[key] = {
          lastFetchTime: entry.timestamp,
          size: JSON.stringify(entry.data).length,
          hits: stats.hits,
          misses: stats.misses
        };
        return acc;
      }, {} as Record<string, { lastFetchTime: number; size: number; hits: number; misses: number }>),
      errorRate,
      errorRateByPath,
      backoffStates: backoffStatesObj
    };
  }
}
