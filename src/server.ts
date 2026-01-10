import express, { Request, Response, NextFunction } from 'express';
import { ConfigLoader } from './config';
import { CacheManager } from './cache';
import { PollingScheduler } from './scheduler';
import { PluginManager } from './plugins';
import { Logger } from './logger';

export class ProxyServer {
  private app: express.Application;
  private cacheManager: CacheManager;
  private scheduler: PollingScheduler;
  private pluginManager: PluginManager;
  private server: any;

  constructor() {
    this.app = express();
    this.pluginManager = new PluginManager();
    this.cacheManager = new CacheManager(this.pluginManager);
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

    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        cache: this.cacheManager.getCacheStats(),
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

    // Proxy all other requests
    this.app.use(async (req: Request, res: Response) => {
      try {
        const fullUrl = req.originalUrl;
        const path = req.path;

        Logger.debug(`Proxying request: ${req.method} ${fullUrl}`);

        // Only handle GET requests with caching
        if (req.method !== 'GET') {
          // For non-GET requests, always forward to backend
          const result = await this.cacheManager.fetchFromBackend(path, fullUrl);
          
          // Set headers
          Object.keys(result.headers).forEach(key => {
            res.setHeader(key, result.headers[key]);
          });
          
          return res.json(result.data);
        }

        // GET request - use cache
        const { entry, fromCache } = await this.cacheManager.getOrFetch(path, fullUrl);

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
