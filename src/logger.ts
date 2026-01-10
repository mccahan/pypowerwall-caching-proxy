import { ConfigLoader } from './config';

export class Logger {
  private static isDebugMode(): boolean {
    try {
      const config = ConfigLoader.get();
      return config.proxy.debug ?? false;
    } catch {
      // If config is not loaded yet, check environment variable
      return process.env.DEBUG === 'true' || process.env.DEBUG === '1';
    }
  }

  static debug(message: string, ...args: any[]): void {
    if (this.isDebugMode()) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  }

  static info(message: string, ...args: any[]): void {
    console.log(message, ...args);
  }

  static error(message: string, ...args: any[]): void {
    console.error(message, ...args);
  }
}
