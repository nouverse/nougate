import { useEffect } from 'react';
import { withBase } from '@/lib/host';
import { useQueryClient } from '@tanstack/react-query';

type LogSubscriber = (message: { timestamp: string; message: string }) => void;
const logSubscribers = new Set<LogSubscriber>();
const capturedLogs: { timestamp: string; message: string }[] = [];

export function subscribeToLogs(subscriber: LogSubscriber) {
  logSubscribers.add(subscriber);
  return () => {
    logSubscribers.delete(subscriber);
  };
}

export function getCachedLogs() {
  return capturedLogs;
}

export function clearCachedLogs() {
  capturedLogs.length = 0;
  logSubscribers.forEach((sub) => sub({ timestamp: '', message: '--- Logs Cleared ---' }));
}

export function useSSE() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: any = null;

    function connect() {
      eventSource = new EventSource(withBase('/api/sse'));

      eventSource.addEventListener('init', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.logs && Array.isArray(data.logs)) {
            clearCachedLogs();
            data.logs.forEach((logStr: string) => {
              capturedLogs.push({
                timestamp: new Date().toLocaleTimeString(),
                message: logStr,
              });
            });
            logSubscribers.forEach((sub) => sub({ timestamp: '', message: '' }));
          }
          queryClient.invalidateQueries({ queryKey: ['providers'] });
          queryClient.invalidateQueries({ queryKey: ['config'] });
        } catch (err) {
          console.error('Failed to parse SSE init event:', err);
        }
      });

      eventSource.addEventListener('update', () => {
        queryClient.invalidateQueries({ queryKey: ['providers'] });
        queryClient.invalidateQueries({ queryKey: ['providers', 'antigravity'] });
        queryClient.invalidateQueries({ queryKey: ['providers', 'antigravity', 'accounts'] });
      });

      eventSource.addEventListener('cooldown', () => {
        queryClient.invalidateQueries({ queryKey: ['providers', 'antigravity'] });
        queryClient.invalidateQueries({ queryKey: ['providers', 'antigravity', 'accounts'] });
      });

      eventSource.addEventListener('flash', (e) => {
        try {
          const data = JSON.parse(e.data);
          const event = new CustomEvent('nougate:flash', { detail: data });
          window.dispatchEvent(event);
        } catch (err) {
          console.error('Failed to handle SSE flash event:', err);
        }
      });

      eventSource.addEventListener('log', (e) => {
        try {
          const data = JSON.parse(e.data);
          const logItem = {
            timestamp: new Date().toLocaleTimeString(),
            message: data.message || '',
          };
          capturedLogs.push(logItem);
          if (capturedLogs.length > 1000) {
            capturedLogs.shift();
          }
          logSubscribers.forEach((sub) => sub(logItem));
        } catch (err) {
          console.error('Failed to handle SSE log event:', err);
        }
      });

      eventSource.onerror = () => {
        console.warn('SSE connection lost. Reconnecting in 3 seconds...');
        if (eventSource) {
          eventSource.close();
        }
        reconnectTimeout = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      if (eventSource) {
        eventSource.close();
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
    };
  }, [queryClient]);
}
