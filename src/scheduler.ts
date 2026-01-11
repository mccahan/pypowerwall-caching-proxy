import { ConfigLoader } from './config';
import { CacheManager } from './cache';
import { Logger } from './logger';

export class PollingScheduler {
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private cacheManager: CacheManager;

  constructor(cacheManager: CacheManager) {
    this.cacheManager = cacheManager;
  }

  async warmCache(): Promise<void> {
    const config = ConfigLoader.get();
    
    // Get all paths that have a pollInterval configured
    const pathsToWarm = config.urlConfigs
      .filter(urlConfig => urlConfig.pollInterval && urlConfig.pollInterval > 0)
      .map(urlConfig => urlConfig.path);
    
    if (pathsToWarm.length === 0) {
      Logger.info('No paths configured with pollInterval, skipping cache warming');
      return;
    }
    
    Logger.info(`Warming cache for ${pathsToWarm.length} path(s)...`);
    
    // Poll all paths in parallel
    const warmPromises = pathsToWarm.map(async (path) => {
      try {
        Logger.debug(`Warming cache for ${path}...`);
        await this.cacheManager.fetchFromBackend(path);
        Logger.debug(`Successfully warmed cache for ${path}`);
      } catch (error) {
        Logger.error(`Error warming cache for ${path}:`, error);
      }
    });
    
    await Promise.all(warmPromises);
    Logger.info('Cache warming complete');
  }

  start(): void {
    const config = ConfigLoader.get();
    
    Logger.info('Starting polling scheduler...');
    
    config.urlConfigs.forEach(urlConfig => {
      if (urlConfig.pollInterval && urlConfig.pollInterval > 0) {
        this.schedulePolling(urlConfig.path, urlConfig.pollInterval);
      }
    });

    Logger.info(`Scheduled ${this.intervals.size} polling intervals`);
  }

  private schedulePolling(path: string, intervalSeconds: number): void {
    Logger.debug(`Scheduling polling for ${path} every ${intervalSeconds} seconds`);
    
    // Schedule recurring polls (initial poll is done during cache warming)
    const interval = setInterval(() => {
      this.poll(path);
    }, intervalSeconds * 1000);

    this.intervals.set(path, interval);
  }

  private async poll(path: string): Promise<void> {
    // Skip polling if endpoint is in backoff
    if (this.cacheManager.isEndpointInBackoff(path)) {
      Logger.debug(`Skipping poll for ${path} (endpoint in backoff)`);
      return;
    }
    
    try {
      Logger.debug(`Polling ${path}...`);
      await this.cacheManager.fetchFromBackend(path);
      Logger.debug(`Successfully polled ${path}`);
    } catch (error) {
      Logger.error(`Error polling ${path}:`, error);
    }
  }

  stop(): void {
    Logger.info('Stopping polling scheduler...');
    this.intervals.forEach((interval, path) => {
      clearInterval(interval);
      Logger.debug(`Stopped polling for ${path}`);
    });
    this.intervals.clear();
  }

  getActivePolls(): string[] {
    return Array.from(this.intervals.keys());
  }
}
