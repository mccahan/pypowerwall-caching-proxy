export interface BackendConfig {
  url: string;
}

export interface ProxyConfig {
  port: number;
}

export interface CacheConfig {
  defaultTTL: number;
  defaultStaleTime: number;
  slowRequestTimeout: number;
}

export interface UrlConfig {
  path: string;
  pollInterval?: number;
  cacheTTL?: number;
  staleTime?: number;
}

export interface PluginConfig {
  mqtt?: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    prefix?: string;
  };
}

export interface Config {
  backend: BackendConfig;
  proxy: ProxyConfig;
  cache: CacheConfig;
  urlConfigs: UrlConfig[];
  plugins?: PluginConfig;
}

export interface CacheEntry {
  data: any;
  headers: Record<string, string>;
  timestamp: number;
  ttl: number;
  staleTime: number;
}

export interface PendingRequest {
  promise: Promise<CacheEntry>;
  timestamp: number;
}

export interface Plugin {
  name: string;
  initialize(): Promise<void>;
  onResponse(path: string, data: any): Promise<void>;
  shutdown(): Promise<void>;
}
