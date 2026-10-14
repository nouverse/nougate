/**
 * Suffixing client tool names on the way up, and putting them back on the way down.
 *
 * Every test here is a way the round trip fails asymmetrically — renamed in one place and not
 * another. That class of bug does not produce an error: it produces a model calling a tool the client
 * never declared, or a client rejecting a name it does not recognise, with nothing in either log
 * saying a rename happened at all.
 */

import { describe, expect, test } from 'bun:test';
import {
  adaptToolNames,
  createToolNameRestoreStream,
  restoreResponse,
  restoreStreamEvent,
  restoreToolNames,
} from '@/providers/claudecode/mappers/tool-names';
import { CC_NATIVE_TOOLS } from '@/providers/claudecode/config/constants';

const SUFFIX = '_ide';

/** Read an SSE stream back to a string, the way a client would receive it. */
async function pipeSse(chunks: string[], map: Map<string, string> | null): Promise<string> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  return await new Response(source.pipeThrough(createToolNameRestoreStream(map))).text();
}

describe('renaming on the way up', () => {
  test('client tools are suffixed and mapped back', () => {
    const { body, toolNameMap } = adaptToolNames(
      { tools: [{ name: 'Read', input_schema: { type: 'object' } }] },
      SUFFIX,
    );

    expect(body.tools[0].name).toBe('Read_ide');
    expect(toolNameMap!.get('Read_ide')).toBe('Read');
  });

  test('server-side built-ins keep their reserved name', () => {
    // A tool carrying a `type` is executed by Anthropic and its name is reserved — suffixing one is a
    // rejected request, not a cosmetic difference.
    const { body, toolNameMap } = adaptToolNames(
      {
        tools: [
          { type: 'web_search_20250305', name: 'web_search' },
          { name: 'Read', input_schema: { type: 'object' } },
        ],
      },
      SUFFIX,
    );

    expect(toolNameMap!.size).toBe(1);
    expect(toolNameMap!.get('Read_ide')).toBe('Read');
    expect(body.tools[0].name).toBe('web_search');
    expect(body.tools[1].name).toBe('Read_ide');
  });

  test('tool_use blocks already in the history are renamed too', () => {
    // Miss these and the upstream sees a conversation referring to tools that were never declared.
    const { body } = adaptToolNames(
      {
        tools: [{ name: 'Read' }],
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'reading' },
              { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'content' }],
          },
        ],
      },
      SUFFIX,
    );

    expect(body.messages[0].content[1].name).toBe('Read_ide');
    // tool_result has no `name` field; passes through untouched.
    expect(body.messages[1].content[0].name).toBeUndefined();
  });

  test('a forced tool_choice points at the name that was actually declared', () => {
    // Missing this is an outright rejection: "Tool 'Read' not found in provided tools".
    const { body } = adaptToolNames(
      { tools: [{ name: 'Read' }], tool_choice: { type: 'tool', name: 'Read' } },
      SUFFIX,
    );
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'Read_ide' });
  });

  test('a tool_choice naming a built-in is left alone', () => {
    const { body } = adaptToolNames(
      {
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        tool_choice: { type: 'tool', name: 'web_search' },
      },
      SUFFIX,
    );
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'web_search' });
  });

  test('tool_choice shapes other than a forced tool are untouched', () => {
    const { body } = adaptToolNames(
      { tools: [{ name: 'Read' }], tool_choice: { type: 'auto' } },
      SUFFIX,
    );
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  test('no tools means no map and the original body, not a copy', () => {
    const original = { messages: [] };
    const { body, toolNameMap } = adaptToolNames(original, SUFFIX);
    expect(body).toBe(original);
    expect(toolNameMap).toBeNull();
  });

  test('built-ins only means no map — nothing was renamed', () => {
    const { toolNameMap } = adaptToolNames(
      { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      SUFFIX,
    );
    expect(toolNameMap).toBeNull();
  });

  test('the suffix is configurable, because it must not collide with a real client tool', () => {
    const { body } = adaptToolNames({ tools: [{ name: 'Read' }] }, '_gw');
    expect(body.tools[0].name).toBe('Read_gw');
  });
});

describe('native tool definitions', () => {
  test('adaptToolNames appends all 20 CC native tools after client tools', () => {
    const { body } = adaptToolNames(
      { tools: [{ name: 'MyTool', input_schema: { type: 'object' } }] },
      SUFFIX,
    );

    // 1 client tool (suffixed) + 20 native tools = 21 total
    expect(body.tools.length).toBe(1 + CC_NATIVE_TOOLS.length);
    expect(body.tools[0].name).toBe('MyTool_ide');
    expect(body.tools[1].name).toBe('Task');
    expect(body.tools[body.tools.length - 1].name).toBe('ExitPlanMode');
  });

  test('native tools all have "currently unavailable" description', () => {
    const { body } = adaptToolNames(
      { tools: [{ name: 'MyTool' }] },
      SUFFIX,
    );

    const nativeTools = body.tools.slice(1);
    for (const tool of nativeTools) {
      expect(tool.description).toBe('This tool is currently unavailable.');
      expect(tool.input_schema).toEqual({ type: 'object', properties: {} });
    }
  });

  test('server-side built-ins are preserved before native tools', () => {
    const { body } = adaptToolNames(
      {
        tools: [
          { type: 'web_search_20250305', name: 'web_search' },
          { name: 'Read', input_schema: { type: 'object' } },
        ],
      },
      SUFFIX,
    );

    // built-in + suffixed client tool + 20 native = 22
    expect(body.tools.length).toBe(22);
    expect(body.tools[0].name).toBe('web_search');
    expect(body.tools[1].name).toBe('Read_ide');
    expect(body.tools[2].name).toBe('Task');
  });

  test('native tools are not included in the toolNameMap', () => {
    const { toolNameMap } = adaptToolNames(
      { tools: [{ name: 'MyTool' }] },
      SUFFIX,
    );

    expect(toolNameMap!.has('Task')).toBe(false);
    expect(toolNameMap!.has('Bash')).toBe(false);
    expect(toolNameMap!.has('MyTool_ide')).toBe(true);
  });
});

describe('restoring names in a non-streaming response', () => {
  test('tool_use names come back as the client declared them', () => {
    const map = new Map([['Read_ide', 'Read']]);
    const body = restoreToolNames(
      { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read_ide', input: {} }] },
      map,
    );
    expect(body.content[1].name).toBe('Read');
    expect(body.content[0]).toEqual({ type: 'text', text: 'hi' });
  });

  test('a name the map does not know passes through rather than being stripped', () => {
    // The model is free to name something this gateway never declared. The client's own error for an
    // unknown tool is more useful than one invented here.
    const body = restoreToolNames(
      { content: [{ type: 'tool_use', name: 'Something_else', input: {} }] },
      new Map([['Read_ide', 'Read']]),
    );
    expect(body.content[0].name).toBe('Something_else');
  });

  test('an empty map changes nothing', () => {
    const original = { content: [{ type: 'tool_use', name: 'Read_ide' }] };
    expect(restoreToolNames(original, null)).toBe(original);
    expect(restoreToolNames(original, new Map())).toBe(original);
  });
});

describe('restoring names in a live stream', () => {
  const map = new Map([['Read_ide', 'Read']]);

  test('the name on content_block_start is restored', () => {
    const event = {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'Read_ide', input: {} },
    };
    expect(restoreStreamEvent(event, map).content_block.name).toBe('Read');
  });

  test('argument deltas carry no name and are returned untouched', () => {
    const event = { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a"' } };
    expect(restoreStreamEvent(event, map)).toBe(event);
  });

  test('event: lines survive — an Anthropic client dispatches on them', async () => {
    // The OpenAI transformer discards these because it is building a different protocol. Dropping
    // them here would hand an Anthropic client a stream it cannot read at all.
    const sse =
      'event: content_block_start\n' +
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read_ide' } })}\n` +
      '\n';

    const out = await pipeSse([sse], map);
    expect(out).toContain('event: content_block_start');
    expect(out).toContain('"name":"Read"');
    expect(out).not.toContain('Read_ide');
  });

  test('a name split across two network chunks is still rewritten', async () => {
    // SSE arrives in arbitrary pieces. A transformer that assumes one event per chunk works in tests
    // and fails on a slow connection.
    const payload = JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'Read_ide' },
    });
    const line = `event: content_block_start\ndata: ${payload}\n\n`;
    const split = Math.floor(line.length / 2);

    const out = await pipeSse([line.slice(0, split), line.slice(split)], map);
    expect(out).toContain('"name":"Read"');
  });

  test('text deltas keep their exact original bytes', async () => {
    // Unchanged events are forwarded verbatim rather than re-serialised, so key order and spacing of
    // the overwhelming majority of events are untouched.
    const sse = 'event: content_block_delta\ndata: {"type":"content_block_delta",  "index":0}\n\n';
    expect(await pipeSse([sse], map)).toBe(sse);
  });

  test('a payload that is not JSON is forwarded, not swallowed', async () => {
    const sse = 'data: not-json-at-all\n\n';
    expect(await pipeSse([sse], map)).toBe(sse);
  });

  test('[DONE] is left alone', async () => {
    expect(await pipeSse(['data: [DONE]\n\n'], map)).toBe('data: [DONE]\n\n');
  });

  test('a stream with no trailing newline still emits its last line', async () => {
    const payload = JSON.stringify({
      type: 'content_block_start',
      content_block: { type: 'tool_use', name: 'Read_ide' },
    });
    expect(await pipeSse([`data: ${payload}`], map)).toContain('"name":"Read"');
  });
});

describe('restoreResponse', () => {
  test('a non-streaming body is rewritten, status and headers preserved', async () => {
    const upstream = new Response(
      JSON.stringify({ content: [{ type: 'tool_use', name: 'Read_ide' }] }),
      { status: 200, headers: { 'x-request-id': 'req_1' } },
    );

    const out = await restoreResponse(upstream, new Map([['Read_ide', 'Read']]), false);
    expect((await out.json()).content[0].name).toBe('Read');
    expect(out.headers.get('x-request-id')).toBe('req_1');
  });

  test('an error body that is not JSON is handed back exactly as it arrived', async () => {
    // Upstream errors are not always JSON, and inventing one here hides what actually happened.
    const upstream = new Response('upstream exploded', { status: 502 });
    const out = await restoreResponse(upstream, new Map([['Read_ide', 'Read']]), false);

    expect(out.status).toBe(502);
    expect(await out.text()).toBe('upstream exploded');
  });

  test('with no map the response object is passed straight through', async () => {
    const upstream = new Response('{}');
    expect(await restoreResponse(upstream, null, false)).toBe(upstream);
  });

  test('content-encoding is not re-asserted on a body fetch already decoded', async () => {
    // The bug this exists to prevent broke every tool-carrying request: `fetch` decompresses the body
    // but leaves `content-encoding: gzip` on the header list, and copying it onto the rewritten body
    // tells the client to gunzip plain JSON. It fails outright rather than degrading.
    const upstream = new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'Read_ide' }] }), {
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    });

    const out = await restoreResponse(upstream, new Map([['Read_ide', 'Read']]), false);
    expect(out.headers.get('content-encoding')).toBeNull();
    expect(out.headers.get('content-type')).toBe('application/json');
  });

  test('a stale content-length does not survive the rewrite', async () => {
    // The rewritten JSON is almost never the length that arrived, so a copied header makes the client
    // truncate the response or wait for bytes that never come.
    const body = JSON.stringify({ content: [{ type: 'tool_use', name: 'Read_ide' }] });
    const upstream = new Response(body, {
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    });

    const out = await restoreResponse(upstream, new Map([['Read_ide', 'Read']]), false);
    const text = await out.text();
    const declared = out.headers.get('content-length');
    // Either stripped entirely, or rewritten to match the new body.
    expect(declared === null || declared === String(text.length)).toBe(true);
  });

  test('a stream is not framed as gzip either', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: ping\ndata: {}\n\n'));
        controller.close();
      },
    });

    const upstream = new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
    });

    const out = await restoreResponse(upstream, new Map([['Read_ide', 'Read']]), true);
    expect(out.headers.get('content-encoding')).toBeNull();
    expect(await out.text()).toContain('event: ping');
  });
});
