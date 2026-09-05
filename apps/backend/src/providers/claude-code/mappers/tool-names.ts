/**
 * Renaming client tools on the way up, and putting the names back on the way down.
 *
 * ## Why a rename is needed at all
 *
 * An OAuth subscription credential runs the request in a context where Claude Code's own tool names
 * mean something. A client that declares a tool called `Read`, `Bash`, `Edit` or `Task` is declaring
 * a name the upstream already has an opinion about, and the collision does not fail loudly — it
 * produces a model that calls the tool it was already trained to call, with the arguments that tool
 * expects, and the client receives something it cannot execute.
 *
 * Suffixing every client tool sidesteps the collision entirely. `Read` goes up as `Read_ide`, comes
 * back as `Read`, and the client never learns this happened.
 *
 * ## The three places a tool name appears, and all three have to agree
 *
 *   1. `tools[]` — the declaration.
 *   2. `messages[].content[]` `tool_use` blocks — the history of what was already called. Miss these
 *      and the upstream sees a conversation referring to tools that were never declared.
 *   3. `tool_choice` when it is `{ type: "tool", name }` — a forced call. Miss it and the request is
 *      rejected outright with "Tool '<name>' not found in provided tools".
 *
 * `tool_result` blocks are keyed by `tool_use_id`, not by name, so they need nothing.
 *
 * ## Server-side built-ins are left alone
 *
 * A tool carrying a `type` (`web_search_20250305` and friends) is executed by Anthropic, not by the
 * client, and its `name` is reserved — suffixing one is a rejected request. They pass through whole.
 *
 * ## What is deliberately not here
 *
 * The reference also injects a list of non-callable tools named after Claude Code's natives, every
 * one of them described "This tool is currently unavailable". They cannot be called and change no
 * behaviour; the only thing they alter is what the tool manifest looks like from outside. That is not
 * a mechanic this file is missing — it is one with nothing to do.
 */

/** Suffixed name → the name the client actually used. Built on the way up, spent on the way down. */
export type ToolNameMap = Map<string, string>;

export interface CloakedRequest {
  body: any;
  /** `null` when nothing was renamed, which is the common case — no tools, or built-ins only. */
  toolNameMap: ToolNameMap | null;
}

/**
 * Rename every client-declared tool, and everything that refers to one.
 *
 * Returns the map rather than storing it, so the caller owns the lifetime — it is valid for exactly
 * one request/response pair and holding it anywhere else would apply one request's renames to
 * another's stream.
 */
export function cloakToolNames(body: any, suffix: string): CloakedRequest {
  const tools = body?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return { body, toolNameMap: null };

  const toolNameMap: ToolNameMap = new Map();
  const renamedClientTools = new Set<string>();

  const declarations = tools.map((tool: any) => {
    // Server-side built-ins carry a `type` and require their exact reserved name.
    if (tool?.type) return tool;
    if (typeof tool?.name !== 'string') return tool;

    const suffixed = `${tool.name}${suffix}`;
    toolNameMap.set(suffixed, tool.name);
    renamedClientTools.add(tool.name);
    return { ...tool, name: suffixed };
  });

  if (toolNameMap.size === 0) return { body, toolNameMap: null };

  // History: every `tool_use` block naming a tool this request renamed.
  const messages = Array.isArray(body.messages)
    ? body.messages.map((message: any) => {
        if (!Array.isArray(message?.content)) return message;
        return {
          ...message,
          content: message.content.map((block: any) =>
            block?.type === 'tool_use' && renamedClientTools.has(block.name)
              ? { ...block, name: `${block.name}${suffix}` }
              : block,
          ),
        };
      })
    : body.messages;

  const cloaked: any = { ...body, tools: declarations, messages };

  // A forced choice must point at the name that was actually declared. Only rewritten when it names
  // a tool this request renamed — a built-in went up unsuffixed and must stay that way.
  if (body.tool_choice?.type === 'tool' && renamedClientTools.has(body.tool_choice.name)) {
    cloaked.tool_choice = { ...body.tool_choice, name: `${body.tool_choice.name}${suffix}` };
  }

  return { body: cloaked, toolNameMap };
}

/**
 * Put the client's names back in a non-streaming response body.
 *
 * A name the map does not know passes through untouched rather than being stripped or flagged: the
 * model is free to name something this gateway never declared, and the client's own error for an
 * unknown tool is more useful than one invented here.
 */
export function decloakToolNames(body: any, toolNameMap: ToolNameMap | null): any {
  if (!toolNameMap?.size || !Array.isArray(body?.content)) return body;

  return {
    ...body,
    content: body.content.map((block: any) =>
      block?.type === 'tool_use' && toolNameMap.has(block.name)
        ? { ...block, name: toolNameMap.get(block.name) }
        : block,
    ),
  };
}

/**
 * Put the client's names back in one parsed SSE event.
 *
 * In an Anthropic stream a tool name appears exactly once per call — on the `content_block_start`
 * that opens the `tool_use` block. The `input_json_delta` events that follow carry arguments and no
 * name, so this is the only event that needs touching.
 */
export function decloakStreamEvent(event: any, toolNameMap: ToolNameMap | null): any {
  if (!toolNameMap?.size || !event || typeof event !== 'object') return event;
  if (event.type !== 'content_block_start') return event;

  const block = event.content_block;
  if (block?.type !== 'tool_use' || typeof block.name !== 'string') return event;

  const original = toolNameMap.get(block.name);
  return original ? { ...event, content_block: { ...block, name: original } } : event;
}

/**
 * Rewrite tool names in a live Anthropic SSE stream, leaving everything else byte-for-byte.
 *
 * This is the part the passthrough path cannot do without. nougate hands an Anthropic response
 * straight back to an Anthropic client, so nothing else in the pipeline would ever look at the
 * stream — and the client would receive `Read_ide`, a tool it never declared, and reject the call.
 *
 * ## Why this re-emits the stream rather than editing bytes in place
 *
 * It parses each `data:` payload and re-serialises it, which means it must preserve what it did not
 * come here to change:
 *
 *   - **`event:` lines.** The Anthropic SSE format carries a named event alongside every `data:`, and
 *     clients dispatch on it. The OpenAI transformer in `core/mappers` discards them because it is
 *     building a different protocol; dropping them here would hand an Anthropic client a stream it
 *     cannot read at all.
 *   - **Anything unparseable.** A payload that is not JSON, or a line that is neither `event:` nor
 *     `data:`, is forwarded untouched. A transformer that swallows what it does not understand is how
 *     a future Anthropic event type silently disappears.
 *   - **The trailing partial line.** SSE arrives in arbitrary chunks; the buffer holds the remainder
 *     between calls, and `flush` emits whatever is left.
 */
export function createToolNameDecloakStream(
  toolNameMap: ToolNameMap | null,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const rewrite = (line: string): string => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) return line;

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return line;

    try {
      const event = JSON.parse(payload);
      const decloaked = decloakStreamEvent(event, toolNameMap);
      // Unchanged events keep their original bytes — no reformatting of whitespace or key order for
      // the overwhelming majority of events, which are text deltas.
      if (decloaked === event) return line;
      return `data: ${JSON.stringify(decloaked)}`;
    } catch {
      return line;
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      // The last element is either an incomplete line or an empty string; either way it waits.
      buffer = lines.pop() ?? '';
      if (lines.length > 0) {
        controller.enqueue(encoder.encode(lines.map(rewrite).join('\n') + '\n'));
      }
    },

    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
    },
  });
}

/**
 * Headers that describe how the *original* bytes were framed, and are lies about the new ones.
 *
 * `fetch` has already decompressed the body by the time this code sees it, but the upstream's
 * `content-encoding: gzip` is still sitting on the header list. Copying it onto a re-emitted body
 * tells the client to gunzip plain JSON, which fails for every single request rather than degrading —
 * and on a stream it corrupts the whole thing before the first event arrives.
 *
 * `content-length` is the same class of mistake with a quieter symptom: the re-serialised JSON is
 * almost never the same length as what arrived, so the client reads the wrong number of bytes and
 * either truncates the response or waits for bytes that never come.
 *
 * `transfer-encoding` is hop-by-hop and belongs to the connection this process is not making.
 */
const REFRAMED_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding'];

/**
 * The upstream's headers, minus the ones that no longer describe the body being sent.
 *
 * A copy: `response.headers` is immutable on some runtimes and shared on others, so mutating it in
 * place is either a throw or an action at a distance.
 */
function reframedHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  for (const name of REFRAMED_HEADERS) headers.delete(name);
  return headers;
}

/**
 * One response, with the client's tool names restored, whichever shape it arrived in.
 *
 * Status is carried across unchanged. Headers are carried across *minus* the framing ones — see
 * `REFRAMED_HEADERS`, which is the difference between this working and every tool request failing.
 */
export async function decloakResponse(
  response: Response,
  toolNameMap: ToolNameMap | null,
  isStreaming: boolean,
): Promise<Response> {
  // Nothing to rewrite means the original object, untouched — no rebuild, no reframing, no risk.
  if (!toolNameMap?.size || !response.body) return response;

  if (isStreaming) {
    return new Response(response.body.pipeThrough(createToolNameDecloakStream(toolNameMap)), {
      status: response.status,
      statusText: response.statusText,
      headers: reframedHeaders(response),
    });
  }

  const text = await response.text();
  try {
    const body = decloakToolNames(JSON.parse(text), toolNameMap);
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers: reframedHeaders(response),
    });
  } catch {
    // Not JSON. Hand back exactly what arrived rather than an error of this file's own invention.
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: reframedHeaders(response),
    });
  }
}
