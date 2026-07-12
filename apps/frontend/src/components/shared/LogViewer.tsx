import React, { useState, useEffect, useRef } from 'react';
import { subscribeToLogs, getCachedLogs, clearCachedLogs } from '../../hooks/useSSE';

interface Props {
  maxHeight?: string;
  showFilters?: boolean;
}

export function LogViewer({ maxHeight = 'h-96', showFilters = true }: Props) {
  const [logs, setLogs] = useState<{ timestamp: string; message: string }[]>([]);
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<'ALL' | 'INFO' | 'WARN' | 'ERROR'>('ALL');
  const [autoScroll, setAutoScroll] = useState(true);
  
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLogs([...getCachedLogs()]);

    const unsubscribe = subscribeToLogs(() => {
      setLogs([...getCachedLogs()]);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = logs.filter((log) => {
    const text = log.message.toLowerCase();
    
    if (search && !text.includes(search.toLowerCase())) {
      return false;
    }

    if (levelFilter === 'ERROR') {
      return text.includes('error') || text.includes('failed') || text.includes('exception');
    }
    if (levelFilter === 'WARN') {
      return text.includes('warn') || text.includes('cooldown') || text.includes('challenge');
    }
    if (levelFilter === 'INFO') {
      const isError = text.includes('error') || text.includes('failed') || text.includes('exception');
      const isWarn = text.includes('warn') || text.includes('cooldown') || text.includes('challenge');
      return !isError && !isWarn;
    }

    return true;
  });

  const getLogLineClass = (msg: string) => {
    const text = msg.toLowerCase();
    if (text.includes('error') || text.includes('failed') || text.includes('exception')) {
      return 'text-error';
    }
    if (text.includes('warn') || text.includes('cooldown') || text.includes('challenge')) {
      return 'text-warning';
    }
    if (text.includes('registered') || text.includes('initialized') || text.includes('success')) {
      return 'text-success';
    }
    return 'text-base-content/85';
  };

  return (
    <div className="flex flex-col h-full bg-neutral text-neutral-content rounded-xl border border-base-300 overflow-hidden font-mono text-xs shadow-inner">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 p-3 bg-base-300/80 border-b border-base-300">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
          <span className="font-semibold text-sm tracking-wide text-base-content">CONSOLE OUTPUT</span>
        </div>
        
        <div className="flex flex-wrap items-center gap-2">
          {showFilters && (
            <>
              <div className="join border border-base-100/50 rounded-lg">
                {(['ALL', 'INFO', 'WARN', 'ERROR'] as const).map((lvl) => (
                  <button
                    key={lvl}
                    className={`join-item btn btn-xs px-2 ${levelFilter === lvl ? 'btn-primary' : 'btn-ghost text-base-content/60'}`}
                    onClick={() => setLevelFilter(lvl)}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
              
              <input
                type="text"
                placeholder="Filter logs..."
                className="input input-xs input-bordered w-full sm:w-32 bg-base-100 text-base-content"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </>
          )}

          <button
            className={`btn btn-xs ${autoScroll ? 'btn-secondary' : 'btn-outline text-base-content/60 border-base-100/50'}`}
            onClick={() => setAutoScroll(!autoScroll)}
          >
            AutoScroll
          </button>

          <button className="btn btn-xs btn-outline btn-error" onClick={clearCachedLogs}>
            Clear
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className={`flex-1 overflow-y-auto p-4 leading-relaxed space-y-1 select-text ${maxHeight}`}
      >
        {filteredLogs.length === 0 ? (
          <div className="text-center text-base-content/30 py-8">--- No Matching Logs ---</div>
        ) : (
          filteredLogs.map((log, i) => (
            <div key={i} className="hover:bg-base-100/10 px-2 py-0.5 rounded transition-colors whitespace-pre-wrap break-all flex gap-2">
              <span className="text-base-content/40 select-none">{log.timestamp}</span>
              <span className={getLogLineClass(log.message)}>{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
