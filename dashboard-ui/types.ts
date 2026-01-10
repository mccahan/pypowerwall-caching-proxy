
export interface BackoffState {
  consecutiveErrors: number;
  nextRetryTime: number;
}

export interface CacheEntry {
  size: number;
  hits: number;
  misses: number;
  lastFetchTime: number;
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

export interface QueueStats {
  queueLength: number;
  isProcessing: boolean;
  currentProcessingUrl: string | null;
  currentProcessingWaitTimeMs: number;
  queuedUrls: string[];
  recentlyCompleted: RecentlyCompletedRequest[];
}
