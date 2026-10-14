/**
 * Tool definitions and client constants for Claude Code protocol compatibility.
 *
 * CC_NATIVE_TOOLS are the 20 native Claude Code tool names, declared as "currently unavailable".
 * They are included alongside the client's own (suffixed) tools by `adaptToolNames` in
 * `mappers/tool-names.ts`.
 */

/** The version string used in billing headers and the User-Agent client header. */
export const CLAUDE_CLI_VERSION = '2.1.299';

/** The entrypoint tag embedded in the billing header. */
export const CC_ENTRYPOINT = 'sdk-cli';

/** Tool schema used by unavailable tools — an empty object, accepting nothing. */
const UNAVAILABLE_SCHEMA = { type: 'object' as const, properties: {} };

/**
 * Claude Code's 20 native tool names, each declared unavailable.
 *
 * Order matches the reference implementation. The names must be exact — they are what the upstream
 * expects to see in a real Claude Code session.
 */
export const CC_NATIVE_TOOLS: ReadonlyArray<{
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, never> };
}> = [
  { name: 'Task', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'TaskOutput', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'TaskStop', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'TaskCreate', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'TaskGet', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'TaskUpdate', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'TaskList', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'Bash', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'Glob', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'Grep', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'Read', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'Edit', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'Write', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'NotebookEdit', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'WebFetch', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'WebSearch', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'AskUserQuestion', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'Skill', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'EnterPlanMode', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
  { name: 'ExitPlanMode', description: 'This tool is currently unavailable.', input_schema: UNAVAILABLE_SCHEMA },
];
