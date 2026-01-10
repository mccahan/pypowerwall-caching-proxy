# pypowerwall-caching-proxy

A high-performance Node.js caching proxy for [pypowerwall](https://github.com/jasonacox/pypowerwall) with intelligent request management, scheduled polling, and configurable caching strategies.

## Features

- **1:1 Request Proxying**: Forwards all requests to the backend pypowerwall server
- **Intelligent Caching**: Cache responses by URL with configurable TTL and stale times
- **Scheduled Polling**: Automatically poll specific endpoints to keep cache fresh
- **Request Queueing**: One request per URL at a time to prevent overwhelming the backend
- **Stale-While-Revalidate**: Serve stale cache while updating in the background
- **Slow Request Fallback**: Return stale cache if backend is slow to respond
- **Docker Support**: Production-ready Dockerfile and docker-compose configuration
- **GitHub Actions**: Automated Docker image building and publishing

## Quick Start

### Using Docker (Recommended)

```bash
# Build the image
docker build -t pypowerwall-proxy .

# Run with environment variables
docker run -p 8676:8676 \
  -e BACKEND_URL=http://your-pypowerwall:8675 \
  pypowerwall-proxy

# Or use docker-compose
docker-compose up
```

### Using Docker Compose

1. Edit `docker-compose.yml` to configure your backend URL
2. Optionally create a `config.json` from `config.example.json`
3. Run: `docker-compose up -d`

### Local Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start the proxy
npm start
```

## Configuration

Configuration can be provided via a `config.json` file or environment variables.

### Environment Variables

- `BACKEND_URL`: Backend pypowerwall server URL (default: `http://localhost:8675`)
- `PROXY_PORT`: Port for the proxy to listen on (default: `8676`)
- `DEFAULT_TTL`: Default cache TTL in seconds (default: `300`)
- `DEFAULT_STALE_TIME`: Default stale time in seconds (default: `60`)
- `SLOW_REQUEST_TIMEOUT`: Timeout for slow requests in milliseconds (default: `5000`)
- `CONFIG_PATH`: Path to config.json file (default: `./config.json`)

### Configuration File

Create a `config.json` based on `config.example.json`:

```json
{
  "backend": {
    "url": "http://localhost:8675"
  },
  "proxy": {
    "port": 8676
  },
  "cache": {
    "defaultTTL": 300,
    "defaultStaleTime": 60,
    "slowRequestTimeout": 5000
  },
  "urlConfigs": [
    {
      "path": "/api/status",
      "pollInterval": 10,
      "cacheTTL": 30,
      "staleTime": 10
    }
  ]
}
```

### URL Configuration Options

- `path`: The URL path to configure
- `pollInterval`: How often to poll this endpoint (in seconds). Set to `0` or omit to disable polling
- `cacheTTL`: How long to cache responses (in seconds)
- `staleTime`: When to consider cache stale and update in background (in seconds)

## API Endpoints

### Proxied Endpoints

All requests not matching special endpoints are proxied to the backend:

```bash
# Examples
curl http://localhost:8676/api/status
curl http://localhost:8676/api/meter
curl http://localhost:8676/api/soe
```

Response headers include:
- `X-Cache-Status`: `HIT` or `MISS`
- `X-Cache-Timestamp`: When the cached data was fetched

### Management Endpoints

**Health Check**
```bash
curl http://localhost:8676/health
```

Returns proxy status, cache statistics, and active polls.

**Cache Statistics**
```bash
curl http://localhost:8676/cache/stats
```

Returns current cache size and cached keys.

**Clear Cache**
```bash
curl -X POST http://localhost:8676/cache/clear
```

Clears all cached entries.

## How It Works

### Caching Strategy

1. **Cache Hit**: If valid cache exists, return immediately
2. **Stale Cache**: If cache is stale but valid, return it and update in background
3. **Cache Miss**: Fetch from backend
4. **Slow Request**: If backend is slow and stale cache exists, return stale cache
5. **Request Queueing**: Only one request per URL at a time; subsequent requests wait for the first

### Polling

URLs configured with `pollInterval` are automatically polled on schedule to keep cache fresh. This ensures that frequently accessed endpoints always have up-to-date data.

### Request Flow

```
Client Request
    ↓
Check Cache
    ↓
Cache Valid? → Yes → Return Cache (+ async update if stale)
    ↓ No
Pending Request? → Yes → Wait for pending request
    ↓ No
Fetch from Backend (with timeout)
    ↓
Timeout? → Yes → Return Stale Cache (if available)
    ↓ No
Update Cache & Return
```

## Development

### Build

```bash
npm run build
```

### Clean

```bash
npm run clean
```

## Docker Image

The Docker image is automatically built and published to GitHub Container Registry on push to main/master or on version tags.

Pull the latest image:
```bash
docker pull ghcr.io/mccahan/pypowerwall-caching-proxy:latest
```

## License

MIT
