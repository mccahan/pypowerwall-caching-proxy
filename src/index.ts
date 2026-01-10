import { ConfigLoader } from './config';
import { ProxyServer } from './server';
import { Logger } from './logger';

// Load configuration
Logger.info('Loading configuration...');
const config = ConfigLoader.load();
Logger.info('Configuration loaded successfully');

// Create and start proxy server
const server = new ProxyServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
  Logger.info('SIGTERM received, shutting down gracefully...');
  await server.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  Logger.info('SIGINT received, shutting down gracefully...');
  await server.stop();
  process.exit(0);
});

// Start the server
server.start().catch((error) => {
  Logger.error('Failed to start server:', error);
  process.exit(1);
});
