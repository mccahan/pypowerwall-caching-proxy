import fs from 'fs';
import path from 'path';
import { Config } from './types';

export class ConfigLoader {
  private static instance: Config | null = null;

  private static isDebugEnabled(): boolean {
    return process.env.DEBUG === 'true' || process.env.DEBUG === '1';
  }

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
      
      // Ensure required fields exist with defaults
      if (!config.cache) {
        config.cache = {
          defaultTTL: 300,
          defaultStaleTime: 60,
          slowRequestTimeout: 5000
        };
      }
    } else {
      // Default configuration
      config = {
        backend: {
          url: process.env.BACKEND_URL || 'http://localhost:8675'
        },
        proxy: {
          port: parseInt(process.env.PROXY_PORT || '8676'),
          debug: this.isDebugEnabled()
        },
        cache: {
          defaultTTL: parseInt(process.env.DEFAULT_TTL || '300'),
          defaultStaleTime: parseInt(process.env.DEFAULT_STALE_TIME || '60'),
          slowRequestTimeout: parseInt(process.env.SLOW_REQUEST_TIMEOUT || '5000')
        },
        urlConfigs: [
          {
            path: '/aggregates',
            pollInterval: 5,
            cacheTTL: 30,
            staleTime: 10,
          },
        ],
        plugins: {}
      };
    }

    // Merge default urlConfigs with config.json urlConfigs
    const defaultUrlConfigs = [
      {
        path: '/aggregates',
        pollInterval: 5,
        cacheTTL: 30,
        staleTime: 5,
      },
      {
        path: '/soe',
        pollInterval: 30,
        cacheTTL: 60,
        staleTime: 25,
      },
      {
        path: '/strings',
        pollInterval: 5,
        cacheTTL: 30,
        staleTime: 5,
      },
      {
        path: '/freq',
        pollInterval: 5,
        cacheTTL: 30,
        staleTime: 20,
      },
      // {
      //   path: '/fans/pw',
      //   pollInterval: 5,
      //   cacheTTL: 30,
      //   staleTime: 5,
      // },
      {
        path: '/csv/v2',
        pollInterval: 10,
        cacheTTL: 60,
        staleTime: 60,
      },
      {
        path: '/version',
        cacheTTL: 600,
        staleTime: 300,
      },
      {
        path: '/alerts/pw',
        cacheTTL: 60,
        staleTime: 45,
      },
    ];

    if (config.urlConfigs) {
      const mergedUrlConfigs = [...defaultUrlConfigs];
      for (const customConfig of config.urlConfigs) {
        const existingConfigIndex = mergedUrlConfigs.findIndex(
          (defaultConfig) => defaultConfig.path === customConfig.path
        );
        if (existingConfigIndex !== -1) {
          mergedUrlConfigs[existingConfigIndex] = {
            ...mergedUrlConfigs[existingConfigIndex],
            ...customConfig,
          };
        } else {
          mergedUrlConfigs.push({
            ...customConfig,
            pollInterval: customConfig.pollInterval ?? 5,
            cacheTTL: customConfig.cacheTTL ?? 30,
            staleTime: customConfig.staleTime ?? 10,
          });
        }
      }
      config.urlConfigs = mergedUrlConfigs;
    } else {
      config.urlConfigs = defaultUrlConfigs;
    }

    // Override with environment variables if present
    if (process.env.BACKEND_URL) {
      config.backend.url = process.env.BACKEND_URL;
    }
    if (process.env.PROXY_PORT) {
      config.proxy.port = parseInt(process.env.PROXY_PORT);
    }
    // Initialize or override debug from environment variable
    if (this.isDebugEnabled()) {
      config.proxy.debug = true;
    } else if (config.proxy.debug === undefined) {
      config.proxy.debug = false;
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
