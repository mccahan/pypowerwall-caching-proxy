import axios, { AxiosError } from 'axios';
import http from 'http';
import https from 'https';
import { ConfigLoader } from './config';
import { BackoffState, ErrorEvent, BackoffError } from './types';
import { Logger } from './logger';

export interface FetchResult {
  data: any;
  headers: Record<string, string>;
}

interface QueuedRequest {
  fullUrl: string;
  resolve: (result: FetchResult) => void;
  reject: (error: any) => void;
  queuedAt: number;
}

interface CompletedRequest {
  fullUrl: string;
  startTime: number;
  endTime: number;
  runtimeMs: number;
  success: boolean;
}

export class ConnectionManager {
  // HTTP/HTTPS agents for connection pooling with keepalive
  private httpAgent: http.Agent;
  private httpsAgent: https.Agent;
  
  // Global request queue - configurable concurrent requests
  private requestQueue: QueuedRequest[] = [];
  private activeRequestCount: number = 0;
  private maxConcurrentRequests: number;
  private activeUrls: Set<string> = new Set();
  private isProcessingQueue: boolean = false;
  
  // Track recently completed requests (last 20)
  private recentlyCompleted: CompletedRequest[] = [];
  private readonly MAX_RECENT_REQUESTS = 20;
  
  // Backoff state tracking
  private backoffStates: Map<string, BackoffState> = new Map();
  private readonly INITIAL_BACKOFF_DELAY = 5000; // 5 seconds
  private readonly MAX_BACKOFF_DELAY = 300000; // 5 minutes
  private readonly BACKOFF_MULTIPLIER = 2;
  
  // Error rate tracking (10-minute window)
  private errorEvents: ErrorEvent[] = [];
  private readonly ERROR_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  private readonly ERROR_WINDOW_MINUTES = 10;

  constructor() {
    const config = ConfigLoader.get();
    this.maxConcurrentRequests = config.backend.maxConcurrentRequests || 2;
    
    // Create HTTP/HTTPS agents with keepalive enabled
    // maxFreeSockets is higher than maxSockets to keep more idle connections for better reuse
    this.httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: this.maxConcurrentRequests,
      maxFreeSockets: this.maxConcurrentRequests * 2,
      timeout: 60000,
    });
    
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: this.maxConcurrentRequests,
      maxFreeSockets: this.maxConcurrentRequests * 2,
      timeout: 60000,
    });
    
    Logger.debug(`ConnectionManager initialized with ${this.maxConcurrentRequests} max concurrent requests`);
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

  isEndpointInBackoff(fullUrl: string): boolean {
    return this.isInBackoff(fullUrl);
  }

  getBackoffStates(): Record<string, { consecutiveErrors: number; backoffDelayMs: number; nextRetryTime: number }> {
    const backoffStatesObj: Record<string, { consecutiveErrors: number; backoffDelayMs: number; nextRetryTime: number }> = {};
    this.backoffStates.forEach((state, path) => {
      backoffStatesObj[path] = {
        consecutiveErrors: state.consecutiveErrors,
        backoffDelayMs: state.backoffDelay,
        nextRetryTime: state.nextRetryTime
      };
    });
    return backoffStatesObj;
  }

  getErrorRateStats(): { errorRate: number; errorRateByPath: Record<string, number> } {
    return this.getErrorStats();
  }

  getQueueStats(): { 
    queueLength: number; 
    activeRequestCount: number;
    maxConcurrentRequests: number;
    queuedUrls: string[];
    activeUrls: string[];
    recentlyCompleted: Array<{
      fullUrl: string;
      startTime: number;
      endTime: number;
      runtimeMs: number;
      success: boolean;
    }>;
  } {
    return {
      queueLength: this.requestQueue.length,
      activeRequestCount: this.activeRequestCount,
      maxConcurrentRequests: this.maxConcurrentRequests,
      queuedUrls: this.requestQueue.map(req => req.fullUrl),
      activeUrls: Array.from(this.activeUrls),
      recentlyCompleted: [...this.recentlyCompleted]
    };
  }

  /**
   * Fetch from backend with global request queueing.
   * Only one request is processed at a time to avoid overloading the backend.
   */
  async fetch(fullUrl: string): Promise<FetchResult> {
    // Check if endpoint is in backoff
    if (this.isInBackoff(fullUrl)) {
      const delay = this.getBackoffDelay(fullUrl);
      const backoffState = this.backoffStates.get(fullUrl);
      Logger.debug(
        `Endpoint ${fullUrl} is in backoff for ${delay}ms ` +
        `(${backoffState?.consecutiveErrors} consecutive errors)`
      );
      
      throw new BackoffError(
        fullUrl,
        delay,
        backoffState?.consecutiveErrors || 0
      );
    }

    // Add request to queue with timestamp
    return new Promise<FetchResult>((resolve, reject) => {
      this.requestQueue.push({ fullUrl, resolve, reject, queuedAt: Date.now() });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    // Prevent concurrent execution of processQueue itself
    if (this.isProcessingQueue) {
      return;
    }
    
    this.isProcessingQueue = true;
    
    try {
      // Process requests up to maxConcurrentRequests limit
      while (this.requestQueue.length > 0 && this.activeRequestCount < this.maxConcurrentRequests) {
        const request = this.requestQueue.shift();
        if (!request) {
          break;
        }

        // Increment active count and track the URL
        this.activeRequestCount++;
        this.activeUrls.add(request.fullUrl);
        
        // Process request asynchronously (don't await here to allow concurrent processing)
        this.executeAndTrackRequest(request).finally(() => {
          this.activeRequestCount--;
          this.activeUrls.delete(request.fullUrl);
          // Continue processing queue if there are more requests
          // Use setImmediate to avoid stack overflow with high request volumes
          setImmediate(() => this.processQueue());
        });
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async executeAndTrackRequest(request: QueuedRequest): Promise<void> {
    const startTime = Date.now();
    let success = false;
    
    try {
      const result = await this.executeRequest(request.fullUrl);
      request.resolve(result);
      success = true;
    } catch (error) {
      request.reject(error);
    } finally {
      const endTime = Date.now();
      const runtimeMs = endTime - startTime;
      
      // Record completed request
      this.recentlyCompleted.unshift({
        fullUrl: request.fullUrl,
        startTime,
        endTime,
        runtimeMs,
        success
      });
      
      // Keep only the most recent requests
      if (this.recentlyCompleted.length > this.MAX_RECENT_REQUESTS) {
        this.recentlyCompleted = this.recentlyCompleted.slice(0, this.MAX_RECENT_REQUESTS);
      }
    }
  }

  private async executeRequest(fullUrl: string): Promise<FetchResult> {
    const config = ConfigLoader.get();
    const backendUrl = `${config.backend.url}${fullUrl}`;

    try {
      // Note: We accept all non-5xx responses (including 4xx) because:
      // - 4xx errors represent valid responses from the backend (e.g., 404 Not Found, 401 Unauthorized)
      // - These should be cached and returned to the client as-is
      // - Only 5xx errors indicate backend failures that should trigger backoff
      const response = await axios.get(backendUrl, {
        timeout: 30000,
        validateStatus: (status: number) => status < 500,
        httpAgent: this.httpAgent,
        httpsAgent: this.httpsAgent,
      });

      const headers: Record<string, string> = {};
      Object.keys(response.headers).forEach(key => {
        headers[key] = String(response.headers[key]);
      });

      // Record successful request (resets backoff)
      this.recordSuccess(fullUrl);

      return {
        data: response.data,
        headers
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      Logger.error(`Error fetching from backend ${backendUrl}:`, axiosError.message);
      
      // Record error for backoff tracking
      this.recordError(fullUrl);
      
      throw error;
    }
  }
}
