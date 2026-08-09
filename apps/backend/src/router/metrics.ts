import {
  exportLogsCsv,
  getApiKeyStats,
  getClientStats,
  getKnownClients,
  getModelStats,
  getProviderStats,
  getRecentLogs,
  getUsageSeries,
  getUsageSummary,
  normalizeLookback,
  type UsageFilters,
} from '@/core/metrics/queries';
import { runMaintenance } from '@/core/metrics/maintenance';
import { tokenMetricsLogger } from '@/core/metrics/logger';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function readFilters(url: URL): UsageFilters {
  return {
    lookback: normalizeLookback(url.searchParams.get('lookback')),
    clientId: url.searchParams.get('clientId') || 'all',
    provider: url.searchParams.get('provider') || 'all',
    apiKeyId: url.searchParams.get('apiKeyId') || 'all',
  };
}

/**
 * Serve the token usage and cost dashboard endpoints.
 * Returns null when the path is not a metrics route.
 */
export async function handleMetricsRoute(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/metrics')) {
    return null;
  }

  try {
    // Flush buffered rows first so the dashboard reflects requests that just
    // finished instead of lagging one batch behind.
    if (req.method === 'GET') {
      tokenMetricsLogger.flush();
    }

    if (url.pathname === '/api/metrics/token-usage' && req.method === 'GET') {
      const filters = readFilters(url);
      return json({
        lookback: filters.lookback,
        summary: getUsageSummary(filters),
        usageData: getUsageSeries(filters),
        modelStats: getModelStats(filters),
        providerStats: getProviderStats(filters),
        clientStats: getClientStats(filters),
        // Computed without the key filter, so the dropdown keeps listing every
        // key even while one of them is selected.
        apiKeyStats: getApiKeyStats({ ...filters, apiKeyId: 'all' }),
        clients: getKnownClients(),
      });
    }

    if (url.pathname === '/api/metrics/recent' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      return json(getRecentLogs(Number.isFinite(limit) ? limit : 50));
    }

    if (url.pathname === '/api/metrics/export' && req.method === 'GET') {
      const filters = readFilters(url);
      const csv = exportLogsCsv(filters);
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="nougate-usage-${filters.lookback}.csv"`,
        },
      });
    }

    if (url.pathname === '/api/metrics/maintenance' && req.method === 'POST') {
      runMaintenance();
      return json({ ok: true });
    }

    return json({ error: 'Unknown metrics endpoint' }, 404);
  } catch (error: any) {
    console.error('[Metrics API] Request failed:', error);
    return json({ error: error?.message || String(error) }, 500);
  }
}
