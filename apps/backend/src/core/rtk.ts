/**
 * RTK — Tool Result Compression
 * 
 * Auto-compress tool_result content (git diff, grep, ls, tree, repeated log lines)
 * before sending to LLM. Pattern-based, inline — zero network overhead. A file an
 * agent reads must reach the model as it is, so each filter detects its own shape
 * strictly and leaves everything else alone.
 * Inspired by 9Router/RTK.
 * 
 * Runs before Headroom as a fast first-pass filter.
 */

import { getProxyConfig } from '@/config/manager';

interface RtkFilter {
  name: string;
  /** Return true if this filter should handle the content */
  detect: (content: string) => boolean;
  /** Compress the content, return compressed version */
  compress: (content: string) => string;
}

// ─── Filters ──────────────────────────────────────────────────────────────────

/** `@@ -12,7 +12,9 @@` — the one line every unified diff has and nothing else does. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

const GIT_DIFF_FILTER: RtkFilter = {
  name: 'git-diff',
  /**
   * A diff, not something that merely starts like one.
   *
   * `---` at the start used to be enough, and every Markdown file with front matter starts with it —
   * each skill's `SKILL.md`, a YAML manifest. Those were compressed as diffs: past the second line in a
   * row that did not begin with `-` or `+`, everything was dropped, so an agent reading a 121-line
   * skill got 30 lines of it and none of its rules. A diff starts with `diff --git`, or with its
   * `---`/`+++` file lines or a hunk header and then has a hunk.
   */
  detect: (c) =>
    c.startsWith('diff --git ') || (/^(--- \S[^\n]*\n\+\+\+ |@@ -)/.test(c) && HUNK_HEADER.test(c)),
  compress: (content) => {
    const lines = content.split('\n');
    const result: string[] = [];
    let contextCount = 0;
    const MAX_CONTEXT = 2; // keep 2 lines of context instead of default 3+

    for (const line of lines) {
      if (line.startsWith('diff --git') || line.startsWith('---') ||
          line.startsWith('+++') || line.startsWith('@@')) {
        contextCount = 0;
        result.push(line);
      } else if (line.startsWith('+') || line.startsWith('-')) {
        contextCount = 0;
        result.push(line);
      } else {
        contextCount++;
        if (contextCount <= MAX_CONTEXT) {
          result.push(line);
        }
        // skip excess context lines
      }
    }
    return result.join('\n');
  },
};

const GREP_FILTER: RtkFilter = {
  name: 'grep',
  detect: (c) => {
    // Typical grep output: "path/file.ts:123:content"
    const lines = c.split('\n').slice(0, 10);
    const grepLines = lines.filter(l => /^[^\s:]+:\d+:/.test(l));
    return grepLines.length >= 3;
  },
  compress: (content) => {
    const lines = content.split('\n');
    const seen = new Set<string>();
    const result: string[] = [];

    for (const line of lines) {
      // Deduplicate identical lines
      if (seen.has(line)) continue;
      seen.add(line);
      result.push(line);
    }
    return result.join('\n');
  },
};

const LS_TREE_FILTER: RtkFilter = {
  name: 'ls-tree',
  detect: (c) => {
    const lines = c.split('\n').slice(0, 20);
    // ls/tree output: mostly paths or lines with tree chars (├── └──)
    const pathLines = lines.filter(l =>
      /^[│├└─\s]*[\w./-]+$/.test(l.trim()) || /\/$/.test(l.trim())
    );
    return pathLines.length >= lines.length * 0.6;
  },
  compress: (content) => {
    const lines = content.split('\n');
    // Collapse empty lines and deduplicate
    const result: string[] = [];
    let prevEmpty = false;
    for (const line of lines) {
      if (line.trim() === '') {
        if (!prevEmpty) result.push('');
        prevEmpty = true;
      } else {
        prevEmpty = false;
        result.push(line);
      }
    }
    return result.join('\n');
  },
};

/**
 * A line repeated straight after itself — a log stuck on one message.
 *
 * Only consecutive repeats count. Counting a line wherever it recurred, as this used to, fired on code
 * and config as readily as on logs: `}` and `},` recur all through a JSON file, `return` all through a
 * Python one. And the compression that followed trimmed every line, dropped every blank line and kept
 * only the first of each — an agent reading a source file got it unindented and out of order.
 */
function repeatsPrevious(line: string, index: number, lines: string[]): boolean {
  return index > 0 && line.trim() !== '' && line === lines[index - 1];
}

const DEDUP_LOG_FILTER: RtkFilter = {
  name: 'dedup-log',
  detect: (c) => {
    const lines = c.split('\n');
    if (lines.length < 10) return false;
    return lines.filter(repeatsPrevious).length >= lines.length * 0.3;
  },
  compress: (content) => {
    const result: string[] = [];
    let run = 0;
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      if (repeatsPrevious(line, index, lines)) {
        run += 1;
        return;
      }
      if (run > 0) result[result.length - 1] += `  (×${run + 1})`;
      run = 0;
      result.push(line);
    });
    if (run > 0) result[result.length - 1] += `  (×${run + 1})`;
    return result.join('\n');
  },
};

const SMART_TRUNCATE_FILTER: RtkFilter = {
  name: 'smart-truncate',
  detect: (c) => c.length > 50000, // >50KB content
  compress: (content) => {
    if (content.length <= 50000) return content;
    const head = content.slice(0, 20000);
    const tail = content.slice(-10000);
    const truncated = content.length - 30000;
    return `${head}\n\n... [${truncated} characters truncated] ...\n\n${tail}`;
  },
};

const FILTERS: RtkFilter[] = [
  SMART_TRUNCATE_FILTER, // run first — cap massive content
  GIT_DIFF_FILTER,
  GREP_FILTER,
  DEDUP_LOG_FILTER,
  LS_TREE_FILTER,
];

// ─── Core ─────────────────────────────────────────────────────────────────────

/** Exported for the tests: what a tool result becomes, whichever filter takes it. */
export function compressText(text: string): string {
  for (const filter of FILTERS) {
    try {
      if (filter.detect(text)) {
        const compressed = filter.compress(text);
        // Only use if it actually saved space
        if (compressed.length < text.length) {
          return compressed;
        }
      }
    } catch {
      // Filter failed — skip silently, never break the request
    }
  }
  return text;
}

/**
 * Apply RTK compression to tool_result content in Anthropic-format messages.
 */
function compressAnthropicMessages(messages: any[]): any[] {
  return messages.map((msg: any) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg;
    if (!Array.isArray(msg.content)) return msg;

    const newContent = msg.content.map((block: any) => {
      if (block.type !== 'tool_result') return block;

      if (typeof block.content === 'string' && block.content.length > 500) {
        return { ...block, content: compressText(block.content) };
      }

      if (Array.isArray(block.content)) {
        return {
          ...block,
          content: block.content.map((c: any) => {
            if (c.type === 'text' && typeof c.text === 'string' && c.text.length > 500) {
              return { ...c, text: compressText(c.text) };
            }
            return c;
          }),
        };
      }

      return block;
    });

    return { ...msg, content: newContent };
  });
}

/**
 * Apply RTK compression to tool role messages in OpenAI-format.
 */
function compressOpenAIMessages(messages: any[]): any[] {
  return messages.map((msg: any) => {
    if (msg.role !== 'tool') return msg;
    if (typeof msg.content === 'string' && msg.content.length > 500) {
      return { ...msg, content: compressText(msg.content) };
    }
    return msg;
  });
}

/**
 * Apply RTK tool result compression to a request body.
 * Auto-detects Anthropic vs OpenAI format.
 * Returns the body with compressed tool results (or original if RTK is disabled).
 */
export function applyRtk(body: any): any {
  const config = getProxyConfig();
  if (!config.rtk?.enabled) return body;
  if (!body.messages || !Array.isArray(body.messages)) return body;

  // Detect format: Anthropic has tool_result blocks, OpenAI has tool role messages
  const isAnthropic = body.messages.some((m: any) =>
    Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')
  );

  const compressed = isAnthropic
    ? compressAnthropicMessages(body.messages)
    : compressOpenAIMessages(body.messages);

  return { ...body, messages: compressed };
}
