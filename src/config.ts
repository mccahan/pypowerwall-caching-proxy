import fs from 'fs';
import path from 'path';
import { Config } from './types';

export class ConfigLoader {
  private static instance: Config | null = null;

  static load(): Config {
    if (this.instance) {
      return this.instance;
    }

    // Try to load from environment variable or default path
    const configPath = process.env.CONFIG_PATH || path.join(process.cwd(), 'config.json');
    
    let config: Config;
    
    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(configData);
    } else {
      // Default configuration
      config = {
        backend: {
          url: process.env.BACKEND_URL || 'http://localhost:8675'
        },
        proxy: {
          port: parseInt(process.env.PROXY_PORT || '8676')
        },
        cache: {
          defaultTTL: parseInt(process.env.DEFAULT_TTL || '300'),
          defaultStaleTime: parseInt(process.env.DEFAULT_STALE_TIME || '60'),
          slowRequestTimeout: parseInt(process.env.SLOW_REQUEST_TIMEOUT || '5000')
        },
        urlConfigs: [
          {
            "path": "/aggregates",
            "pollInterval": 5,
            "cacheTTL": 30,
            "staleTime": 10,
          },
        ]
      };
    }

    // Override with environment variables if present
    if (process.env.BACKEND_URL) {
      config.backend.url = process.env.BACKEND_URL;
    }
    if (process.env.PROXY_PORT) {
      config.proxy.port = parseInt(process.env.PROXY_PORT);
    }

    this.instance = config;
    return config;
  }

  static get(): Config {
    if (!this.instance) {
      return this.load();
    }
    return this.instance;
  }
}
