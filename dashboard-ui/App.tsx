import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
  Activity, 
  Database, 
  Layers, 
  Clock, 
  Trash2, 
  RefreshCcw, 
  CheckCircle2, 
  XCircle, 
  Search,
  AlertCircle
} from 'lucide-react';
import { CacheStats, QueueStats, BackoffState, CacheEntry, ActiveRequest } from './types';
import { motion, AnimatePresence } from 'framer-motion';

const API_BASE = '';
const WS_BASE = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_BASE}//${window.location.host}/ws`;
const MIN_DISPLAY_TIME = 500; // Minimum time to show a request in ms

const App: React.FC = () => {
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showConfirmClear, setShowConfirmClear] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  
  // Track active requests with minimum display time
  const activeRequestTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const [displayedActiveRequests, setDisplayedActiveRequests] = useState<ActiveRequest[]>([]);

  const fetchCacheStats = useCallback(async () => {
    try {
      const cacheRes = await fetch(`${API_BASE}/cache/stats`);
      
      if (!cacheRes.ok) throw new Error('Failed to fetch cache stats');
      
      const cacheData = await cacheRes.json();
      
      setCacheStats(cacheData);
      setLastUpdate(new Date());
      setError(null);
    } catch (err) {
      console.error(err);
      setError('Connection lost. Attempting to reconnect...');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchQueueStats = useCallback(async () => {
    try {
      const queueRes = await fetch(`${API_BASE}/queue/stats`);
      
      if (!queueRes.ok) throw new Error('Failed to fetch queue stats');
      
      const queueData = await queueRes.json();
      
      setQueueStats(queueData);
      updateDisplayedActiveRequests(queueData.activeUrls);
    } catch (err) {
      console.error('Error fetching queue stats:', err);
    }
  }, []);

  // Update displayed active requests with minimum display time
  const updateDisplayedActiveRequests = useCallback((newActiveRequests: ActiveRequest[]) => {
    setDisplayedActiveRequests(prevDisplayed => {
      const now = Date.now();
      const newDisplayed = [...newActiveRequests];
      const currentUrls = new Set(newActiveRequests.map(r => r.url));
      
      // Keep requests that just completed visible for minimum display time
      prevDisplayed.forEach(req => {
        if (!currentUrls.has(req.url)) {
          const elapsed = now - req.startTime;
          if (elapsed < MIN_DISPLAY_TIME) {
            // Request just finished but hasn't been visible for minimum time
            // Keep showing it with its current runtime (frozen at completion)
            newDisplayed.push(req);
            
            // Set a timer to remove it after minimum display time
            if (!activeRequestTimers.current.has(req.url)) {
              const remainingTime = MIN_DISPLAY_TIME - elapsed;
              const timer = setTimeout(() => {
                setDisplayedActiveRequests(current => 
                  current.filter(r => r.url !== req.url)
                );
                activeRequestTimers.current.delete(req.url);
              }, remainingTime);
              
              activeRequestTimers.current.set(req.url, timer);
            }
          }
        }
      });
      
      // Clear timers for requests that are active again or already removed
      activeRequestTimers.current.forEach((timer, url) => {
        if (currentUrls.has(url) || !newDisplayed.find(r => r.url === url)) {
          clearTimeout(timer);
          activeRequestTimers.current.delete(url);
        }
      });
      
      return newDisplayed;
    });
  }, []);

  // WebSocket connection for real-time queue updates
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout;

    const connect = () => {
      try {
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
          console.log('WebSocket connected');
          setWsConnected(true);
          setError(null);
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'queueStats') {
              setQueueStats(message.data);
              updateDisplayedActiveRequests(message.data.activeUrls);
              setLastUpdate(new Date());
            }
          } catch (err) {
            console.error('Error parsing WebSocket message:', err);
          }
        };

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          setWsConnected(false);
        };

        ws.onclose = () => {
          console.log('WebSocket disconnected, reconnecting in 3s...');
          setWsConnected(false);
          reconnectTimeout = setTimeout(connect, 3000);
        };
      } catch (err) {
        console.error('Error creating WebSocket:', err);
        setWsConnected(false);
        reconnectTimeout = setTimeout(connect, 3000);
      }
    };

    // Initial fetch for queue stats (WebSocket will provide updates after)
    fetchQueueStats();
    
    // Connect to WebSocket
    connect();

    return () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (ws) {
        ws.close();
      }
      // Clear all active request timers
      activeRequestTimers.current.forEach(timer => clearTimeout(timer));
      activeRequestTimers.current.clear();
    };
  }, [fetchQueueStats, updateDisplayedActiveRequests]);

  // Poll for cache stats only (queue stats come via WebSocket)
  useEffect(() => {
    fetchCacheStats();
    const interval = setInterval(fetchCacheStats, 2000); // Poll cache stats every 2 seconds
    return () => clearInterval(interval);
  }, [fetchCacheStats]);

  const handleClearCache = async () => {
    setIsClearing(true);
    try {
      const res = await fetch(`${API_BASE}/cache/clear`, { method: 'POST' });
      if (res.ok) {
        setShowConfirmClear(false);
        await fetchCacheStats();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsClearing(false);
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const formatSize = (bytes: number) => {
    if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  const filteredCacheKeys = useMemo(() => {
    if (!cacheStats) return [];
    return (Object.entries(cacheStats.keys) as [string, CacheEntry][])
      .filter(([key]) => key.toLowerCase().includes(searchQuery.toLowerCase()))
      .sort((a, b) => a[0].localeCompare(b[0])); // Sort by key in ascending order
  }, [cacheStats, searchQuery]);

  if (loading && !cacheStats) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-4">
          <RefreshCcw className="w-12 h-12 text-indigo-600 animate-spin mx-auto" />
          <p className="text-slate-500 font-medium">Initializing Dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600 rounded-lg text-white">
              <Activity className="w-6 h-6" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">PyPowerwall Proxy</h1>
          </div>
          <p className="mt-1 text-slate-500 text-sm">Real-time caching server health and metrics</p>
        </div>

        <div className="flex items-center gap-3">
          {error && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 text-amber-700 rounded-full text-xs font-medium border border-amber-200">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
          {wsConnected && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-full text-xs font-medium border border-emerald-200">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
              Live Updates
            </div>
          )}
          <div className="text-right hidden sm:block">
            <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Last Sync</p>
            <p className="text-xs font-medium text-slate-600">
              {lastUpdate ? lastUpdate.toLocaleTimeString() : '---'}
            </p>
          </div>
          <button 
            onClick={() => setShowConfirmClear(true)}
            disabled={isClearing}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg text-sm font-semibold shadow-sm transition-all"
          >
            <Trash2 className="w-4 h-4 text-red-500" />
            Clear Cache
          </button>
        </div>
      </header>

      {/* Main Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard 
          icon={<Database className="w-5 h-5" />}
          label="Cache Size"
          value={cacheStats?.size || 0}
          subValue="Entries"
          color="indigo"
        />
        <StatCard 
          icon={<Layers className="w-5 h-5" />}
          label="Queue Length"
          value={queueStats?.queueLength || 0}
          subValue="Pending Requests"
          color="blue"
        />
        <StatCard 
          icon={<Clock className="w-5 h-5" />}
          label="Error Rate"
          value={cacheStats?.errorRate.toFixed(2) || '0.00'}
          subValue="Errors / min"
          color="rose"
        />
        <StatCard 
          icon={<Activity className="w-5 h-5" />}
          label="Worker Status"
          value={queueStats?.activeRequestCount ? `${queueStats.activeRequestCount} Active` : 'Idle'}
          subValue={queueStats?.activeRequestCount ? `Processing (max ${queueStats.maxConcurrentRequests})` : 'Waiting for tasks'}
          color={queueStats?.activeRequestCount ? 'emerald' : 'slate'}
          isActive={queueStats?.activeRequestCount > 0}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Cache Section */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden" style={{ minHeight: '442px' }}>
            <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Database className="w-5 h-5 text-indigo-600" />
                <h2 className="font-semibold text-slate-800">Cache Explorer</h2>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  type="text" 
                  placeholder="Filter keys..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 pr-4 py-1.5 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 w-full sm:w-64"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-50 text-slate-500 text-[10px] font-bold uppercase tracking-wider">
                  <tr>
                    <th className="px-6 py-3">Key / Path</th>
                    <th className="px-6 py-3">Performance</th>
                    <th className="px-6 py-3">Avg Response</th>
                    <th className="px-6 py-3">Max Response</th>
                    <th className="px-6 py-3">Size</th>
                    <th className="px-6 py-3 text-right">Last Fetch</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredCacheKeys.length > 0 ? (
                    filteredCacheKeys.map(([key, info]) => {
                      const total = info.hits + info.misses;
                      const hitRate = total > 0 ? (info.hits / total) * 100 : 0;
                      return (
                        <tr key={key} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex flex-col">
                              <span className="mono text-xs font-medium text-slate-700 truncate max-w-[200px] md:max-w-xs" title={key}>
                                {key}
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between text-[10px] font-medium text-slate-500">
                                <span>Hit Rate</span>
                                <span>{hitRate.toFixed(1)}%</span>
                              </div>
                              <div className="w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                <div 
                                  className={`h-full rounded-full ${hitRate > 70 ? 'bg-emerald-500' : hitRate > 30 ? 'bg-indigo-500' : 'bg-rose-500'}`}
                                  style={{ width: `${hitRate}%` }}
                                />
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            {info.avgResponseTime !== undefined ? (
                              <span className="text-xs text-slate-600 font-medium">
                                {formatDuration(info.avgResponseTime)}
                              </span>
                            ) : (
                              <span className="text-xs text-slate-400 font-medium">-</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            {info.maxResponseTime !== undefined ? (
                              <span className="text-xs text-slate-600 font-medium">
                                {formatDuration(info.maxResponseTime)}
                              </span>
                            ) : (
                              <span className="text-xs text-slate-400 font-medium">-</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-xs text-slate-600 font-medium">{formatSize(info.size)}</span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <span className="text-xs text-slate-400 font-medium">
                              {new Date(info.lastFetchTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-slate-400 italic text-sm">
                        No cached entries matching your search
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Queue & Backoff Section */}
        <div className="space-y-6">
          {/* Current Activity */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="w-5 h-5 text-indigo-600" />
              <h2 className="font-semibold text-slate-800">Processing Queue</h2>
            </div>
            
            <div style={{ height: '360px', overflowY: 'auto' }}>
              <div className="space-y-2 mb-4">
                <p className="text-[10px] font-bold text-indigo-500 uppercase tracking-wider mb-1">
                  Processing Now ({displayedActiveRequests.length}/{queueStats?.maxConcurrentRequests || 0})
                </p>
                {Array.from({ length: queueStats?.maxConcurrentRequests || 0 }).map((_, i) => {
                  const activeReq = displayedActiveRequests[i];
                  return (
                    <div
                      style={{ minHeight: '62px' }}
                      key={i}
                      className={`p-3 border rounded-lg ${
                        activeReq ? 'bg-indigo-50 border-indigo-100' : 'bg-slate-50 border-slate-100'
                      }`}
                    >
                      {activeReq ? (
                        <>
                          <p className="mono text-xs text-indigo-900 break-all mb-1">{activeReq.url}</p>
                          <div className="flex items-center justify-between">
                            <p className="text-[10px] text-indigo-700 font-medium">
                              Running: {formatDuration(activeReq.runtimeMs)}
                            </p>
                            <div className="flex space-x-0.5">
                              <div className="w-1 h-3 bg-indigo-400 animate-pulse" />
                              <div className="w-1 h-3 bg-indigo-400 animate-pulse delay-75" />
                              <div className="w-1 h-3 bg-indigo-400 animate-pulse delay-150" />
                            </div>
                          </div>
                        </>
                      ) : (
                        <p className="mono text-xs text-slate-400 text-center">&nbsp;</p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Queued URLs */}
              <div className="space-y-2 mt-4">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">In Queue</h3>
                  {queueStats?.queuedUrls.map((url, i) => (
                    <div
                      key={url}
                      className="flex items-center gap-2 p-2 bg-slate-50 border border-slate-100 rounded text-[11px] mono text-slate-600 truncate"
                    >
                      <span className="text-slate-300">#{i + 1}</span>
                      {url}
                    </div>
                  ))}
              </div>
            </div>
          </div>

          {/* Recent History */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Recently Completed</h3>
            <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
              {queueStats?.recentlyCompleted.map((req, i) => (
                <div key={i} className="flex gap-3 p-2.5 hover:bg-slate-50 rounded-lg transition-colors border border-transparent hover:border-slate-100">
                  <div className="mt-0.5">
                    {req.success ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-500" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="mono text-[11px] text-slate-700 truncate" title={req.fullUrl}>
                      {req.fullUrl}
                    </p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[10px] text-slate-400 font-medium">{formatDuration(req.runtimeMs)}</span>
                      <span className="text-[10px] text-slate-400 font-medium">•</span>
                      <span className="text-[10px] text-slate-400 font-medium">{new Date(req.endTime).toLocaleTimeString([], { hour12: false })}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Backoff States */}
          {cacheStats && Object.keys(cacheStats.backoffStates).length > 0 && (
            <div className="bg-rose-50 rounded-xl border border-rose-100 p-5">
              <div className="flex items-center gap-2 mb-4">
                <AlertCircle className="w-5 h-5 text-rose-600" />
                <h2 className="font-semibold text-rose-900">Active Backoffs</h2>
              </div>
              <div className="space-y-3">
                {(Object.entries(cacheStats.backoffStates) as [string, BackoffState][]).map(([path, state]) => {
                  const retryIn = Math.max(0, state.nextRetryTime - Date.now());
                  return (
                    <div key={path} className="p-3 bg-white/50 rounded-lg border border-rose-200/50">
                      <p className="mono text-xs text-rose-900 mb-1">{path}</p>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-rose-500 uppercase">{state.consecutiveErrors} Errors</span>
                        <span className="text-[10px] font-medium text-rose-600">Retry in {formatDuration(retryIn)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Confirmation Modal */}
      {showConfirmClear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 animate-in fade-in zoom-in duration-200">
            <div className="w-12 h-12 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center mb-4 mx-auto">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 text-center mb-2">Clear entire cache?</h3>
            <p className="text-slate-500 text-sm text-center mb-6">
              This will remove all cached responses. Clients will experience increased latency while cache rebuilds.
            </p>
            <div className="flex gap-3">
              <button 
                onClick={() => setShowConfirmClear(false)}
                className="flex-1 py-2 px-4 border border-slate-200 text-slate-600 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleClearCache}
                disabled={isClearing}
                className="flex-1 py-2 px-4 bg-rose-600 text-white rounded-lg text-sm font-semibold hover:bg-rose-700 shadow-md shadow-rose-200 transition-colors flex items-center justify-center gap-2"
              >
                {isClearing ? <RefreshCcw className="w-4 h-4 animate-spin" /> : 'Yes, Clear All'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Helper Components
interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subValue: string;
  color: 'indigo' | 'blue' | 'emerald' | 'rose' | 'slate';
  isActive?: boolean;
}

const StatCard: React.FC<StatCardProps> = ({ icon, label, value, subValue, color, isActive }) => {
  const colors = {
    indigo: 'bg-indigo-50 text-indigo-600',
    blue: 'bg-blue-50 text-blue-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    rose: 'bg-rose-50 text-rose-600',
    slate: 'bg-slate-50 text-slate-600'
  };

  return (
    <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-200 relative overflow-hidden group">
      <div className={`p-2 rounded-lg w-fit mb-3 ${colors[color]}`}>
        {icon}
      </div>
      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">{label}</p>
      <div className="flex items-baseline gap-2 mt-1">
        <h3 className="text-2xl font-bold text-slate-900">{value}</h3>
        {isActive && (
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500 mt-1">{subValue}</p>
      
      <div className={`absolute bottom-0 left-0 h-1 transition-all duration-500 w-0 group-hover:w-full ${
        color === 'indigo' ? 'bg-indigo-500' :
        color === 'blue' ? 'bg-blue-500' :
        color === 'emerald' ? 'bg-emerald-500' :
        color === 'rose' ? 'bg-rose-500' : 'bg-slate-500'
      }`} />
    </div>
  );
};

export default App;
