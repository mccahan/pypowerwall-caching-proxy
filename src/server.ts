import express, { Request, Response, NextFunction } from 'express';
import { ConfigLoader } from './config';
import { CacheManager } from './cache';
import { PollingScheduler } from './scheduler';

export class ProxyServer {
  private app: express.Application;
  private cacheManager: CacheManager;
  private scheduler: PollingScheduler;
  private server: any;

  constructor() {
    this.app = express();
    this.cacheManager = new CacheManager();
    this.scheduler = new PollingScheduler(this.cacheManager);
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
      });
      next();
    });

    // Parse JSON bodies
    this.app.use(express.json());
  }

  private setupRoutes(): void {
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
      res.json(this.cacheManager.getCacheStats());
    });

    // Proxy all other requests
    this.app.use(async (req: Request, res: Response) => {
      try {
        const fullUrl = req.originalUrl;
        const path = req.path;

        console.log(`Proxying request: ${req.method} ${fullUrl}`);

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

        res.json(entry.data);
      } catch (error) {
        console.error('Error handling request:', error);
        res.status(500).json({ 
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }

  start(): void {
    const config = ConfigLoader.get();
    
    this.server = this.app.listen(config.proxy.port, () => {
      console.log(`Pypowerwall caching proxy listening on port ${config.proxy.port}`);
      console.log(`Backend URL: ${config.backend.url}`);
      console.log(`Cache TTL: ${config.cache.defaultTTL}s`);
      console.log(`Stale time: ${config.cache.defaultStaleTime}s`);
      console.log(`Slow request timeout: ${config.cache.slowRequestTimeout}ms`);
    });

    // Start polling scheduler
    this.scheduler.start();
  }

  stop(): void {
    console.log('Stopping proxy server...');
    this.scheduler.stop();
    
    if (this.server) {
      this.server.close(() => {
        console.log('Proxy server stopped');
      });
    }
  }
}
