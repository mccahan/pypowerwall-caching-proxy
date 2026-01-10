import { ConfigLoader } from './config';
import { CacheManager } from './cache';

export class PollingScheduler {
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private cacheManager: CacheManager;

  constructor(cacheManager: CacheManager) {
    this.cacheManager = cacheManager;
  }

  start(): void {
    const config = ConfigLoader.get();
    
    console.log('Starting polling scheduler...');
    
    config.urlConfigs.forEach(urlConfig => {
      if (urlConfig.pollInterval && urlConfig.pollInterval > 0) {
        this.schedulePolling(urlConfig.path, urlConfig.pollInterval);
      }
    });

    console.log(`Scheduled ${this.intervals.size} polling intervals`);
  }

  private schedulePolling(path: string, intervalSeconds: number): void {
    console.log(`Scheduling polling for ${path} every ${intervalSeconds} seconds`);
    
    // Initial poll
    this.poll(path);
    
    // Schedule recurring polls
    const interval = setInterval(() => {
      this.poll(path);
    }, intervalSeconds * 1000);

    this.intervals.set(path, interval);
  }

  private async poll(path: string): Promise<void> {
    try {
      console.log(`Polling ${path}...`);
      await this.cacheManager.fetchFromBackend(path, path);
      console.log(`Successfully polled ${path}`);
    } catch (error) {
      console.error(`Error polling ${path}:`, error);
    }
  }

  stop(): void {
    console.log('Stopping polling scheduler...');
    this.intervals.forEach((interval, path) => {
      clearInterval(interval);
      console.log(`Stopped polling for ${path}`);
    });
    this.intervals.clear();
  }

  getActivePolls(): string[] {
    return Array.from(this.intervals.keys());
  }
}
