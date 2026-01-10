import { Plugin } from '../types';
import { MqttPlugin } from './mqtt';
import { ConfigLoader } from '../config';

export class PluginManager {
  private plugins: Plugin[] = [];

  constructor() {
    const config = ConfigLoader.get();
    
    // Initialize MQTT plugin
    const mqttPlugin = new MqttPlugin(config.plugins?.mqtt);
    this.plugins.push(mqttPlugin);
  }

  async initialize(): Promise<void> {
    console.log('Initializing plugins...');
    
    for (const plugin of this.plugins) {
      try {
        await plugin.initialize();
      } catch (error) {
        console.error(`Error initializing plugin ${plugin.name}:`, error);
        // Continue with other plugins
      }
    }
    
    console.log('Plugins initialized');
  }

  async notifyResponse(path: string, data: any): Promise<void> {
    // Call all plugins in parallel, but don't wait or fail if they error
    const promises = this.plugins.map(async (plugin) => {
      try {
        await plugin.onResponse(path, data);
      } catch (error) {
        console.error(`Plugin ${plugin.name} error:`, error);
        // Don't throw - plugins should not break the response flow
      }
    });

    // Fire and forget - don't wait for plugins to complete
    Promise.all(promises).catch((error) => {
      console.error('Plugin notification error:', error);
    });
  }

  async shutdown(): Promise<void> {
    console.log('Shutting down plugins...');
    
    for (const plugin of this.plugins) {
      try {
        await plugin.shutdown();
      } catch (error) {
        console.error(`Error shutting down plugin ${plugin.name}:`, error);
      }
    }
    
    console.log('Plugins shut down');
  }
}
