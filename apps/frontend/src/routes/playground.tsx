import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useModelCatalog, useApiKeys, useConfig } from '@/hooks/useQueries';
import { CopyButton } from '@/components/shared/CopyButton';
import { formatCost, formatDuration, formatTokens } from '@/lib/format';
import { Play, Square, Terminal, Zap, AlertTriangle, Search } from 'lucide-react';

export const Route = createFileRoute('/playground')({
  component: PlaygroundPage,
});

type Protocol = 'openai' | 'anthropic';

interface RunResult {
  status: number;
  ok: boolean;
  text: string;
  raw: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Pull the assistant text and usage out of either protocol's response shape.
 */
function readFinalBody(protocol: Protocol, body: any): { text: string; input: number | null; output: number | null } {
  if (protocol === 'anthropic') {
    const text = (body?.content ?? [])
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => block.text)
      .join('');
    return {
      text,
      input: body?.usage?.input_tokens ?? null,
      output: body?.usage?.output_tokens ?? null,
    };
  }

  const message = body?.choices?.[0]?.message;
  return {
    text: message?.content ?? '',
    input: body?.usage?.prompt_tokens ?? null,
    output: body?.usage?.completion_tokens ?? null,
  };
}

/**
 * Extract the incremental text and any usage from one SSE event.
 */
function readStreamEvent(protocol: Protocol, event: any): { delta: string; input?: number; output?: number } {
  if (protocol === 'anthropic') {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return { delta: event.delta.text ?? '' };
    }
    if (event.type === 'message_start') {
      return { delta: '', input: event.message?.usage?.input_tokens };
    }
    if (event.type === 'message_delta') {
      return { delta: '', output: event.usage?.output_tokens };
    }
    return { delta: '' };
  }

  const result: { delta: string; input?: number; output?: number } = {
    delta: event.choices?.[0]?.delta?.content ?? '',
  };
  if (event.usage) {
    result.input = event.usage.prompt_tokens;
    result.output = event.usage.completion_tokens;
  }
  return result;
}

function PlaygroundPage() {
  const { data: catalog } = useModelCatalog();
  const { data: apiKeys } = useApiKeys();
  const { data: config } = useConfig();

  const [protocol, setProtocol] = useState<Protocol>('openai');
  const [model, setModel] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [userPrompt, setUserPrompt] = useState('Say hello in one short sentence.');
  const [stream, setStream] = useState(true);
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('1024');
  const [apiKey, setApiKey] = useState('');

  const [running, setRunning] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  // Proxy routes always require a key — the playground is deliberately subject
  // to the same check as any other client.
  const hasActiveKey = (apiKeys?.keys ?? []).some((key) => !key.revoked);
  const baseUrl = config?.baseUrl || window.location.origin;

  /** Providers present in the catalogue, with how many models each contributes. */
  const providers = useMemo(() => {
    const counts = new Map<string, { id: string; name: string; count: number }>();
    for (const entry of catalog ?? []) {
      const existing = counts.get(entry.providerId);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(entry.providerId, { id: entry.providerId, name: entry.providerName, count: 1 });
      }
    }
    return Array.from(counts.values()).sort((a, b) => a.id.localeCompare(b.id));
  }, [catalog]);

  const models = useMemo(() => {
    const needle = modelSearch.trim().toLowerCase();
    return (catalog ?? [])
      .filter((entry) => providerFilter === 'all' || entry.providerId === providerFilter)
      .filter((entry) => !needle || entry.id.toLowerCase().includes(needle));
  }, [catalog, modelSearch, providerFilter]);

  // Keep the selection inside the visible list. Without this, narrowing the
  // filters would leave the picker displaying a model it no longer lists, and
  // the request would go to that hidden model instead of the one on screen.
  useEffect(() => {
    if (models.length === 0) {
      return;
    }
    if (!model || !models.some((entry) => entry.id === model)) {
      setModel(models[0].id);
    }
  }, [models, model]);

  // Keep the newest streamed token in view.
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [liveText]);

  const selected = catalog?.find((entry) => entry.id === model) ?? null;
  const endpoint =
    protocol === 'openai' ? '/openai/v1/chat/completions' : '/anthropic/v1/messages';

  const buildBody = () => {
    const body: any = { model, stream };

    if (protocol === 'anthropic') {
      body.max_tokens = parseInt(maxTokens, 10) || 1024;
      if (systemPrompt.trim()) {
        body.system = systemPrompt;
      }
      body.messages = [{ role: 'user', content: userPrompt }];
    } else {
      body.messages = [
        ...(systemPrompt.trim() ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: userPrompt },
      ];
      if (maxTokens) {
        body.max_tokens = parseInt(maxTokens, 10);
      }
    }

    if (temperature !== '') {
      body.temperature = parseFloat(temperature);
    }

    return body;
  };

  const curlCommand = useMemo(() => {
    const authHeader = protocol === 'anthropic'
      ? `-H "x-api-key: ${apiKey || 'sk-nou-...'}"`
      : `-H "Authorization: Bearer ${apiKey || 'sk-nou-...'}"`;

    return [
      `curl ${baseUrl}${endpoint} \\`,
      `  -H "Content-Type: application/json" \\`,
      `  ${authHeader} \\`,
      `  -d '${JSON.stringify(buildBody())}'`,
    ].join('\n');
    // buildBody reads the same state this depends on.
  }, [protocol, endpoint, baseUrl, apiKey, model, stream, systemPrompt, userPrompt, temperature, maxTokens]);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  };

  const run = async () => {
    if (!model) {
      setError('Pick a model first.');
      return;
    }

    setRunning(true);
    setError(null);
    setResult(null);
    setLiveText('');

    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey.trim()) {
      // Send whichever header this protocol's clients normally use.
      if (protocol === 'anthropic') {
        headers['x-api-key'] = apiKey.trim();
      } else {
        headers.Authorization = `Bearer ${apiKey.trim()}`;
      }
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildBody()),
        signal: controller.signal,
      });

      if (!response.ok || !stream) {
        const raw = await response.text();
        let text = raw;
        let input: number | null = null;
        let output: number | null = null;

        try {
          const parsed = JSON.parse(raw);
          if (response.ok) {
            const read = readFinalBody(protocol, parsed);
            text = read.text;
            input = read.input;
            output = read.output;
          } else {
            text = parsed?.error?.message || raw;
          }
        } catch {
          // Non-JSON body — show it verbatim.
        }

        setResult({
          status: response.status,
          ok: response.ok,
          text,
          raw,
          durationMs: Date.now() - startedAt,
          inputTokens: input,
          outputTokens: output,
        });
        return;
      }

      // Streamed: decode SSE and append as it arrives.
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let collected = '';
      let rawLog = '';
      let input: number | null = null;
      let output: number | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        rawLog += chunk;
        buffer += chunk;

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) {
            continue;
          }
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') {
            continue;
          }

          try {
            const event = readStreamEvent(protocol, JSON.parse(payload));
            if (event.delta) {
              collected += event.delta;
              setLiveText(collected);
            }
            if (typeof event.input === 'number') {
              input = event.input;
            }
            if (typeof event.output === 'number') {
              output = event.output;
            }
          } catch {
            // Partial JSON across chunk boundaries — the buffer picks it up next round.
          }
        }
      }

      setResult({
        status: response.status,
        ok: true,
        text: collected,
        raw: rawLog,
        durationMs: Date.now() - startedAt,
        inputTokens: input,
        outputTokens: output,
      });
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setError(err?.message || String(err));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const estimatedCost =
    selected && result?.inputTokens != null && result?.outputTokens != null
      ? (result.inputTokens * selected.inputPricePer1M +
         result.outputTokens * selected.outputPricePer1M) / 1_000_000
      : null;

  const displayText = running ? liveText : result?.text ?? liveText;

  return (
    <div className="space-y-6 text-base-content min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-base-300 pb-4">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight">API Playground</h1>
          <p className="text-xs text-base-content/50 mt-0.5">
            Send a real request through the gateway — same routes, same auth, same metrics your
            clients hit.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start">
          <div className="tabs tabs-box bg-base-200 p-0.5 rounded-lg">
            {(['openai', 'anthropic'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`tab tab-xs rounded-md ${protocol === option ? 'tab-active font-semibold' : 'text-base-content/60'}`}
                onClick={() => setProtocol(option)}
              >
                {option === 'openai' ? 'OpenAI' : 'Anthropic'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 min-w-0">
        {/* ── Request ─────────────────────────────────────────────────────── */}
        <div className="card bg-base-200 border border-base-300 shadow-sm min-w-0">
          <div className="card-body p-5 space-y-4 min-w-0">
            <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" />
              REQUEST
            </h3>

            <div className="form-control w-full">
              <label className="label">
                <span className="label-text font-semibold text-xs text-base-content/75">
                  Model
                </span>
                <span className="label-text-alt text-[10px] text-base-content/40">
                  {models.length} of {catalog?.length ?? 0}
                </span>
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                <select
                  className="select select-bordered select-sm w-full bg-base-100 text-xs"
                  value={providerFilter}
                  onChange={(event) => setProviderFilter(event.target.value)}
                >
                  <option value="all">All providers ({catalog?.length ?? 0})</option>
                  {providers.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name} ({entry.count})
                    </option>
                  ))}
                </select>

                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" />
                  <input
                    type="text"
                    placeholder="Filter models..."
                    className="input input-bordered input-sm w-full bg-base-100 text-xs pl-8"
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                  />
                </div>
              </div>

              <select
                className="select select-bordered select-sm w-full bg-base-100 font-mono text-xs"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {models.length === 0 && <option value="">No models match these filters</option>}
                {models.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id}
                  </option>
                ))}
              </select>

              {model && (
                <label className="label">
                  <span className="label-text-alt text-[10px] text-base-content/50 flex items-center gap-1">
                    Sent as <code className="font-mono text-primary">{model}</code>
                    <CopyButton value={model} title={`Copy "${model}"`} />
                  </span>
                </label>
              )}
            </div>

            <div className="form-control w-full">
              <label className="label">
                <span className="label-text font-semibold text-xs text-base-content/75">
                  System prompt (optional)
                </span>
              </label>
              <textarea
                rows={2}
                className="textarea textarea-bordered w-full bg-base-100 text-xs"
                placeholder="You are a helpful assistant."
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
              />
            </div>

            <div className="form-control w-full">
              <label className="label">
                <span className="label-text font-semibold text-xs text-base-content/75">Message</span>
              </label>
              <textarea
                rows={4}
                className="textarea textarea-bordered w-full bg-base-100 text-xs"
                value={userPrompt}
                onChange={(event) => setUserPrompt(event.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="form-control w-full">
                <label className="label">
                  <span className="label-text font-semibold text-xs text-base-content/75">Max tokens</span>
                </label>
                <input
                  type="number"
                  className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(event.target.value)}
                />
              </div>

              <div className="form-control w-full">
                <label className="label">
                  <span className="label-text font-semibold text-xs text-base-content/75">Temperature</span>
                </label>
                <input
                  type="number"
                  step="0.1"
                  placeholder="default"
                  className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                  value={temperature}
                  onChange={(event) => setTemperature(event.target.value)}
                />
              </div>

              <div className="form-control w-full justify-end pb-2">
                <label className="label cursor-pointer justify-start gap-3">
                  <input
                    type="checkbox"
                    className="toggle toggle-sm toggle-primary"
                    checked={stream}
                    onChange={(event) => setStream(event.target.checked)}
                  />
                  <span className="label-text font-semibold text-xs text-base-content/75">Stream</span>
                </label>
              </div>
            </div>

            <div className="form-control w-full">
              <label className="label">
                <span className="label-text font-semibold text-xs text-base-content/75">
                  Gateway API key <span className="text-error">*</span>
                </span>
              </label>
              <input
                type="password"
                placeholder="sk-nou-..."
                className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              {!apiKey && (
                <label className="label">
                  <span className="label-text-alt text-[10px] text-warning flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    {hasActiveKey
                      ? 'Proxy routes always require a key — this request will be rejected without one.'
                      : 'No keys exist yet. Create one on the API Keys page first.'}
                  </span>
                </label>
              )}
            </div>

            <div className="flex items-center gap-2">
              {running ? (
                <button type="button" className="btn btn-sm btn-error rounded-xl font-semibold gap-1.5" onClick={stop}>
                  <Square className="w-3.5 h-3.5" />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-primary rounded-xl font-semibold gap-1.5"
                  onClick={run}
                  disabled={!model}
                >
                  <Play className="w-3.5 h-3.5" />
                  Send request
                </button>
              )}
              <span className="text-[10px] font-mono text-base-content/40 truncate">
                POST {endpoint}
              </span>
            </div>
          </div>
        </div>

        {/* ── Response ────────────────────────────────────────────────────── */}
        <div className="card bg-base-200 border border-base-300 shadow-sm min-w-0">
          <div className="card-body p-5 space-y-3 min-w-0">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
                <Terminal className="w-4 h-4 text-primary" />
                RESPONSE
              </h3>

              <div className="flex items-center gap-2">
                {result && (
                  <span
                    className={`badge badge-sm font-bold ${result.ok ? 'badge-success' : 'badge-error'}`}
                  >
                    {result.status}
                  </span>
                )}
                {result && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => setShowRaw(!showRaw)}
                  >
                    {showRaw ? 'Pretty' : 'Raw'}
                  </button>
                )}
                {displayText && <CopyButton value={showRaw ? result?.raw ?? '' : displayText} label="Copy" />}
              </div>
            </div>

            {error && (
              <div className="alert alert-error text-xs font-semibold shadow-sm">
                <span>{error}</span>
              </div>
            )}

            <pre
              ref={outputRef}
              className="bg-base-100 border border-base-300 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-words h-72 overflow-y-auto overflow-x-hidden"
            >
              {showRaw
                ? result?.raw || ''
                : displayText ||
                  (running ? '' : 'Response will appear here.')}
              {running && <span className="loading loading-dots loading-xs align-middle ml-1" />}
            </pre>

            {result && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Metric label="Latency" value={formatDuration(result.durationMs)} />
                <Metric
                  label="Input"
                  value={result.inputTokens != null ? formatTokens(result.inputTokens) : '—'}
                />
                <Metric
                  label="Output"
                  value={result.outputTokens != null ? formatTokens(result.outputTokens) : '—'}
                />
                <Metric
                  label="Est. cost"
                  value={estimatedCost != null ? formatCost(estimatedCost) : '—'}
                  hint={selected && !selected.isPriced ? 'model unpriced' : undefined}
                />
              </div>
            )}

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-base-content/40">
                  Equivalent curl
                </span>
                <CopyButton value={curlCommand} label="Copy" />
              </div>
              <pre className="bg-base-100 border border-base-300 rounded-lg p-3 text-[10px] font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {curlCommand}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-base-100 border border-base-300 rounded-lg px-3 py-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-base-content/40 block">
        {label}
      </span>
      <span className="font-mono font-bold text-sm">{value}</span>
      {hint && <span className="block text-[9px] text-base-content/40">{hint}</span>}
    </div>
  );
}
