import { Plugin } from '../types';
import { MqttPlugin } from './mqtt';
import { ResponseValidatorPlugin } from './responseValidator';
import { ConfigLoader } from '../config';
import { Logger } from '../logger';

export class PluginManager {
  private plugins: Plugin[] = [];

  constructor() {
    const config = ConfigLoader.get();
    
    // Initialize response validator plugin
    const validatorPlugin = new ResponseValidatorPlugin();
    this.plugins.push(validatorPlugin);
    
    // Initialize MQTT plugin
    const mqttPlugin = new MqttPlugin(config.plugins?.mqtt);
    this.plugins.push(mqttPlugin);
  }

  async initialize(): Promise<void> {
    Logger.info('Initializing plugins...');
    
    for (const plugin of this.plugins) {
      try {
        await plugin.initialize();
      } catch (error) {
        Logger.error(`Error initializing plugin ${plugin.name}:`, error);
        // Continue with other plugins
      }
    }
    
    Logger.info('Plugins initialized');
  }

  async notifyResponse(path: string, data: any): Promise<void> {
    // Call all plugins - fire and forget, don't wait or fail if they error
    Promise.allSettled(
      this.plugins.map(async (plugin) => {
        try {
          await plugin.onResponse(path, data);
        } catch (error) {
          Logger.error(`Plugin ${plugin.name} error:`, error);
        }
      })
    );
  }

  /**
   * Check if a response should be cached by asking all plugins.
   * Returns false if any plugin returns false, otherwise returns true.
   */
  shouldCache(path: string, data: any): boolean {
    for (const plugin of this.plugins) {
      if (plugin.shouldCache) {
        const result = plugin.shouldCache(path, data);
        if (!result) {
          Logger.debug(`Plugin ${plugin.name} rejected caching for ${path}`);
          return false;
        }
      }
    }
    return true;
  }

  async shutdown(): Promise<void> {
    Logger.info('Shutting down plugins...');
    
    for (const plugin of this.plugins) {
      try {
        await plugin.shutdown();
      } catch (error) {
        Logger.error(`Error shutting down plugin ${plugin.name}:`, error);
      }
    }
    
    Logger.info('Plugins shut down');
  }
}
