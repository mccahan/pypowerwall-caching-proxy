import express, { Request, Response, NextFunction } from 'express';
import { ConfigLoader } from './config';
import { CacheManager } from './cache';
import { PollingScheduler } from './scheduler';
import { PluginManager } from './plugins';
import { Logger } from './logger';
import { ConnectionManager } from './connectionManager';

export class ProxyServer {
  private app: express.Application;
  private cacheManager: CacheManager;
  private scheduler: PollingScheduler;
  private pluginManager: PluginManager;
  private connectionManager: ConnectionManager;
  private server: any;

  constructor() {
    this.app = express();
    this.pluginManager = new PluginManager();
    this.connectionManager = new ConnectionManager();
    this.cacheManager = new CacheManager(this.pluginManager, this.connectionManager);
    this.scheduler = new PollingScheduler(this.cacheManager);
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      res.on('finish', () => {
        // Don't log favicon requests
        if (req.path === '/favicon.ico') {
          return;
        }

        const duration = Date.now() - start;
        Logger.debug(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
      });
      next();
    });

    // Parse JSON bodies
    this.app.use(express.json());
  }

  private setupRoutes(): void {
    // Ignore requests to favicon.ico
    this.app.get('/favicon.ico', (req: Request, res: Response) => {
      res.status(204).end();
    });

    // Web UI endpoint
    this.app.get('/', (req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pypowerwall Caching Proxy - Status</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100">
  <div class="container mx-auto px-4 py-8">
    <h1 class="text-3xl font-bold text-gray-800 mb-8">Pypowerwall Caching Proxy</h1>
    
    <div class="mb-6">
      <button id="clearCache" class="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-red-400">
        Clear Cache
      </button>
      <span id="clearStatus" class="ml-4 text-sm"></span>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <!-- Cache Stats -->
      <div class="bg-white rounded-lg shadow-md p-6">
        <h2 class="text-xl font-semibold text-gray-700 mb-4">Cache Statistics</h2>
        <div id="cacheStats" class="text-sm">
          <p class="text-gray-500">Loading...</p>
        </div>
      </div>

      <!-- Queue Stats -->
      <div class="bg-white rounded-lg shadow-md p-6">
        <h2 class="text-xl font-semibold text-gray-700 mb-4">Connection Queue</h2>
        <div id="queueStats" class="text-sm">
          <p class="text-gray-500">Loading...</p>
        </div>
      </div>
    </div>

    <div class="mt-4 text-sm text-gray-500 text-right">
      Last updated: <span id="lastUpdate">Never</span>
    </div>
  </div>

  <script>
    let pollInterval;

    // Format timestamp
    function formatTime(timestamp) {
      return new Date(timestamp).toLocaleString();
    }

    // Format duration
    function formatDuration(ms) {
      if (ms < 1000) return ms + 'ms';
      return (ms / 1000).toFixed(2) + 's';
    }

    // Fetch and display cache stats
    async function updateCacheStats() {
      try {
        const response = await fetch('./cache/stats');
        const data = await response.json();
        
        let html = '<div class="space-y-2">';
        html += '<p><strong>Cache Size:</strong> ' + data.size + ' entries</p>';
        html += '<p><strong>Error Rate:</strong> ' + data.errorRate.toFixed(2) + ' errors/min</p>';
        
        if (Object.keys(data.backoffStates).length > 0) {
          html += '<div class="mt-4"><strong>Backoff States:</strong></div>';
          html += '<div class="ml-4 text-xs">';
          for (const [path, state] of Object.entries(data.backoffStates)) {
            const retryIn = Math.max(0, state.nextRetryTime - Date.now());
            html += '<p class="text-red-600">' + path + ': ' + state.consecutiveErrors + ' errors, retry in ' + formatDuration(retryIn) + '</p>';
          }
          html += '</div>';
        }
        
        if (Object.keys(data.keys).length > 0) {
          html += '<div class="mt-4"><strong>Cached Entries:</strong></div>';
          html += '<div class="ml-4 space-y-1 max-h-96 overflow-y-auto">';
          for (const [key, info] of Object.entries(data.keys)) {
            const hitRate = info.hits + info.misses > 0 
              ? ((info.hits / (info.hits + info.misses)) * 100).toFixed(1)
              : 0;
            html += '<div class="text-xs border-b border-gray-200 py-1">';
            html += '<p class="font-mono text-gray-800">' + key + '</p>';
            html += '<p class="text-gray-600">Last fetch: ' + formatTime(info.lastFetchTime) + '</p>';
            html += '<p class="text-gray-600">Size: ' + (info.size / 1024).toFixed(2) + ' KB | Hits: ' + info.hits + ' | Misses: ' + info.misses + ' | Hit rate: ' + hitRate + '%</p>';
            html += '</div>';
          }
          html += '</div>';
        }
        
        html += '</div>';
        document.getElementById('cacheStats').innerHTML = html;
      } catch (error) {
        document.getElementById('cacheStats').innerHTML = '<p class="text-red-500">Error loading cache stats</p>';
      }
    }

    // Fetch and display queue stats
    async function updateQueueStats() {
      try {
        const response = await fetch('./queue/stats');
        const data = await response.json();
        
        let html = '<div class="space-y-2">';
        html += '<p><strong>Queue Length:</strong> ' + data.queueLength + '</p>';
        html += '<p><strong>Processing:</strong> ' + (data.isProcessing ? 'Yes' : 'No') + '</p>';
        
        if (data.currentProcessingUrl) {
          html += '<div class="mt-2"><strong>Currently Processing:</strong></div>';
          html += '<p class="ml-4 text-xs font-mono">' + data.currentProcessingUrl + '</p>';
          html += '<p class="ml-4 text-xs text-gray-600">Wait time: ' + formatDuration(data.currentProcessingWaitTimeMs) + '</p>';
        }
        
        if (data.queuedUrls && data.queuedUrls.length > 0) {
          html += '<div class="mt-2"><strong>Queued URLs:</strong></div>';
          html += '<ul class="ml-4 text-xs list-disc list-inside">';
          data.queuedUrls.forEach(url => {
            html += '<li class="font-mono">' + url + '</li>';
          });
          html += '</ul>';
        }
        
        if (data.recentlyCompleted && data.recentlyCompleted.length > 0) {
          html += '<div class="mt-4"><strong>Recently Completed:</strong></div>';
          html += '<div class="ml-4 space-y-1 max-h-96 overflow-y-auto">';
          data.recentlyCompleted.forEach(req => {
            const statusClass = req.success ? 'text-green-600' : 'text-red-600';
            const statusText = req.success ? '✓' : '✗';
            html += '<div class="text-xs border-b border-gray-200 py-1">';
            html += '<p><span class="' + statusClass + '">' + statusText + '</span> <span class="font-mono">' + req.fullUrl + '</span></p>';
            html += '<p class="text-gray-600">Runtime: ' + formatDuration(req.runtimeMs) + ' | Completed: ' + formatTime(req.endTime) + '</p>';
            html += '</div>';
          });
          html += '</div>';
        }
        
        html += '</div>';
        document.getElementById('queueStats').innerHTML = html;
      } catch (error) {
        document.getElementById('queueStats').innerHTML = '<p class="text-red-500">Error loading queue stats</p>';
      }
    }

    // Update all stats
    async function updateStats() {
      await Promise.all([updateCacheStats(), updateQueueStats()]);
      document.getElementById('lastUpdate').textContent = new Date().toLocaleString();
    }

    // Clear cache handler
    document.getElementById('clearCache').addEventListener('click', async () => {
      const button = document.getElementById('clearCache');
      const status = document.getElementById('clearStatus');
      
      button.disabled = true;
      button.textContent = 'Clearing...';
      
      try {
        const response = await fetch('./cache/clear', { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
          status.textContent = '✓ Cache cleared successfully';
          status.className = 'ml-4 text-sm text-green-600';
          setTimeout(() => { status.textContent = ''; }, 3000);
          await updateStats();
        } else {
          throw new Error('Failed to clear cache');
        }
      } catch (error) {
        status.textContent = '✗ Error clearing cache';
        status.className = 'ml-4 text-sm text-red-600';
      } finally {
        button.disabled = false;
        button.textContent = 'Clear Cache';
      }
    });

    // Initial update
    updateStats();

    // Poll every 2 seconds
    pollInterval = setInterval(updateStats, 2000);
  </script>
</body>
</html>`);
    });

    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        cache: this.cacheManager.getCacheStats(),
        queue: this.cacheManager.getQueueStats(),
        activePolls: this.scheduler.getActivePolls()
      });
    });

    // Cache management endpoints
    this.app.post('/cache/clear', (req: Request, res: Response) => {
      this.cacheManager.clearCache();
      res.json({ success: true, message: 'Cache cleared' });
    });

    this.app.get('/cache/stats', (req: Request, res: Response) => {
      const stats = this.cacheManager.getCacheStats();
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(stats, null, 2));
    });

    // Connection queue endpoint
    this.app.get('/queue/stats', (req: Request, res: Response) => {
      const queueStats = this.cacheManager.getQueueStats();
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(queueStats, null, 2));
    });

    // Proxy all other requests
    this.app.use(async (req: Request, res: Response) => {
      try {
        const fullUrl = req.originalUrl;
        const path = req.path;

        Logger.debug(`Proxying request: ${req.method} ${fullUrl}`);

        // Only handle GET requests with caching
        if (req.method !== 'GET') {
          // For non-GET requests, always forward to backend
          const result = await this.cacheManager.fetchFromBackend(fullUrl);
          
          // Set headers
          Object.keys(result.headers).forEach(key => {
            res.setHeader(key, result.headers[key]);
          });
          
          return res.json(result.data);
        }

        // GET request - use cache
        const { entry, fromCache } = await this.cacheManager.getOrFetch(fullUrl);

        if (!entry) {
          return res.status(503).json({ error: 'Service unavailable' });
        }

        // Add cache status header
        res.setHeader('X-Cache-Status', fromCache ? 'HIT' : 'MISS');
        res.setHeader('X-Cache-Timestamp', new Date(entry.timestamp).toISOString());

        // Set original headers
        Object.keys(entry.headers).forEach(key => {
          // Skip some headers that shouldn't be forwarded
          if (!['content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
            res.setHeader(key, entry.headers[key]);
          }
        });

        // Send response
        const contentType = entry.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
          res.setHeader('Content-Type', 'application/json');
          res.send(JSON.stringify(entry.data, null, 2));
        } else {
          res.setHeader('Content-Type', contentType);
          res.send(entry.data);
        }
      } catch (error) {
        Logger.error('Error handling request:', error);
        res.status(500).json({ 
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }

  async start(): Promise<void> {
    const config = ConfigLoader.get();
    
    this.server = this.app.listen(config.proxy.port, () => {
      Logger.info(`Pypowerwall caching proxy listening on port ${config.proxy.port}`);
      Logger.info(`Backend URL: ${config.backend.url}`);
      Logger.info(`Cache TTL: ${config.cache.defaultTTL}s`);
      Logger.info(`Stale time: ${config.cache.defaultStaleTime}s`);
      Logger.info(`Slow request timeout: ${config.cache.slowRequestTimeout}ms`);
      Logger.info(`Debug mode: ${config.proxy.debug ? 'enabled' : 'disabled'}`);
    });

    // Start polling scheduler
    this.scheduler.start();
    
    // Initialize plugins in background (don't block server startup)
    this.pluginManager.initialize().catch((error) => {
      Logger.error('Plugin initialization error:', error);
    });
  }

  async stop(): Promise<void> {
    Logger.info('Stopping proxy server...');
    this.scheduler.stop();
    
    // Shutdown plugins
    await this.pluginManager.shutdown();
    
    if (this.server) {
      this.server.close(() => {
        Logger.info('Proxy server stopped');
      });
    }
  }
}
