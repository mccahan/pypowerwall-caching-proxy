import mqtt, { MqttClient } from 'mqtt';
import { Plugin } from '../types';
import { Logger } from '../logger';

export class MqttPlugin implements Plugin {
  name = 'mqtt';
  private client: MqttClient | null = null;
  private host: string;
  private port: number;
  private username?: string;
  private password?: string;
  private prefix: string;
  private enabled: boolean = false;

  constructor(config?: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    prefix?: string;
  }) {
    // Check environment variables first, then config
    this.host = process.env.MQTT_HOST || config?.host || '';
    const portEnv = process.env.MQTT_PORT;
    this.port = parseInt(portEnv || '', 10) || config?.port || 1883;
    this.username = process.env.MQTT_USER || config?.username;
    this.password = process.env.MQTT_PASSWORD || config?.password;
    this.prefix = process.env.MQTT_PREFIX || config?.prefix || 'pypowerwall/';

    // Ensure prefix ends with /
    if (this.prefix && !this.prefix.endsWith('/')) {
      this.prefix += '/';
    }

    // Only enable if MQTT_HOST is defined
    this.enabled = !!this.host;

    if (this.enabled) {
      Logger.info(`MQTT plugin enabled: ${this.host}:${this.port}, prefix: ${this.prefix}`);
    }
  }

  async initialize(): Promise<void> {
    if (!this.enabled) {
      Logger.info('MQTT plugin disabled (MQTT_HOST not set)');
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        const options: any = {
          port: this.port,
        };

        if (this.username) {
          options.username = this.username;
        }
        if (this.password) {
          options.password = this.password;
        }

        this.client = mqtt.connect(`mqtt://${this.host}`, options);

        this.client.on('connect', () => {
          Logger.info(`MQTT plugin connected to ${this.host}:${this.port}`);
          resolve();
        });

        this.client.on('error', (error) => {
          Logger.error('MQTT connection error:', error.message);
          // Don't reject on error after initial connection attempt
          if (!this.client?.connected) {
            reject(error);
          }
        });

        this.client.on('disconnect', () => {
          Logger.debug('MQTT client disconnected');
        });

        // Timeout for initial connection
        setTimeout(() => {
          if (!this.client?.connected) {
            Logger.error('MQTT connection timeout');
            resolve(); // Don't fail initialization, just log
          }
        }, 5000);
      } catch (error) {
        Logger.error('MQTT plugin initialization error:', error);
        resolve(); // Don't fail initialization
      }
    });
  }

  async onResponse(path: string, data: any): Promise<void> {
    if (!this.enabled || !this.client?.connected) {
      return;
    }

    try {
      if (path === '/aggregates' && data) {
        await this.handleAggregatesResponse(data);
      } else if (path === '/soe' && data) {
        await this.handleSoeResponse(data);
      }
    } catch (error) {
      Logger.error(`MQTT plugin error processing ${path}:`, error instanceof Error ? error.message : error);
      // Don't throw - we don't want to break the response flow
    }
  }

  private async handleAggregatesResponse(data: any): Promise<void> {
    const publishes: Promise<void>[] = [];

    if (data.site?.instant_power !== undefined) {
      publishes.push(this.publish('site/instant_power', data.site.instant_power));
    }

    if (data.battery?.instant_power !== undefined) {
      publishes.push(this.publish('battery/instant_power', data.battery.instant_power));
    }

    if (data.solar?.instant_power !== undefined) {
      publishes.push(this.publish('solar/instant_power', data.solar.instant_power));
    }

    if (data.load?.instant_power !== undefined) {
      publishes.push(this.publish('load/instant_power', data.load.instant_power));
    }

    await Promise.all(publishes);
  }

  private async handleSoeResponse(data: any): Promise<void> {
    if (data.percentage !== undefined) {
      await this.publish('battery/level', data.percentage);
    }
  }

  private async publish(topic: string, value: any): Promise<void> {
    if (!this.client?.connected) {
      return;
    }

    return new Promise((resolve) => {
      const fullTopic = `${this.prefix}${topic}`;
      const payload = typeof value === 'string' ? value : String(value);

      this.client!.publish(fullTopic, payload, (error) => {
        if (error) {
          Logger.error(`MQTT publish error for ${fullTopic}:`, error.message);
        } else {
          Logger.debug(`MQTT published: ${fullTopic} = ${payload}`);
        }
        resolve(); // Always resolve, don't throw
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      return new Promise((resolve) => {
        this.client!.end(false, () => {
          Logger.info('MQTT plugin shutdown');
          resolve();
        });
      });
    }
  }
}
