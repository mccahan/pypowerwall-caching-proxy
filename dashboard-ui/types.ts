
export interface BackoffState {
  consecutiveErrors: number;
  nextRetryTime: number;
}

export interface CacheEntry {
  size: number;
  hits: number;
  misses: number;
  lastFetchTime: number;
  avgResponseTime?: number;
  maxResponseTime?: number;
  pollInterval?: number;
}

export interface CacheStats {
  size: number;
  errorRate: number;
  backoffStates: Record<string, BackoffState>;
  keys: Record<string, CacheEntry>;
}

export interface RecentlyCompletedRequest {
  fullUrl: string;
  success: boolean;
  runtimeMs: number;
  endTime: number;
}

export interface ActiveRequest {
  url: string;
  startTime: number;
  runtimeMs: number;
}

export interface QueueStats {
  queueLength: number;
  activeRequestCount: number;
  maxConcurrentRequests: number;
  queuedUrls: string[];
  activeUrls: ActiveRequest[];
  recentlyCompleted: RecentlyCompletedRequest[];
}
