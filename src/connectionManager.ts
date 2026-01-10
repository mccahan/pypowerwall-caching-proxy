import axios, { AxiosError } from 'axios';
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
}

export class ConnectionManager {
  // Global request queue - only one request at a time
  private requestQueue: QueuedRequest[] = [];
  private isProcessing: boolean = false;
  
  // Backoff state tracking
  private backoffStates: Map<string, BackoffState> = new Map();
  private readonly INITIAL_BACKOFF_DELAY = 5000; // 5 seconds
  private readonly MAX_BACKOFF_DELAY = 300000; // 5 minutes
  private readonly BACKOFF_MULTIPLIER = 2;
  
  // Error rate tracking (10-minute window)
  private errorEvents: ErrorEvent[] = [];
  private readonly ERROR_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  private readonly ERROR_WINDOW_MINUTES = 10;

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

    // Add request to queue
    return new Promise<FetchResult>((resolve, reject) => {
      this.requestQueue.push({ fullUrl, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    // If already processing, return (queue will be processed)
    if (this.isProcessing) {
      return;
    }

    // Mark as processing
    this.isProcessing = true;

    try {
      // Process requests one at a time
      while (this.requestQueue.length > 0) {
        const request = this.requestQueue.shift();
        if (!request) {
          break;
        }

        try {
          const result = await this.executeRequest(request.fullUrl);
          request.resolve(result);
        } catch (error) {
          request.reject(error);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async executeRequest(fullUrl: string): Promise<FetchResult> {
    const config = ConfigLoader.get();
    const backendUrl = `${config.backend.url}${fullUrl}`;

    try {
      const response = await axios.get(backendUrl, {
        timeout: 30000,
        validateStatus: (status: number) => status < 500 // Accept all non-5xx responses
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
