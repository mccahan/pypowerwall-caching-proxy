import { ConfigLoader } from './config';
import { ProxyServer } from './server';

// Load configuration
console.log('Loading configuration...');
const config = ConfigLoader.load();
console.log('Configuration loaded successfully');

// Create and start proxy server
const server = new ProxyServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.stop();
  process.exit(0);
});

// Start the server
server.start();
