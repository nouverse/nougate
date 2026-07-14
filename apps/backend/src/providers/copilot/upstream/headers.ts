export function getCopilotHeaders(sessionToken: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${sessionToken}`,
    'Content-Type': 'application/json',
    'Editor-Version': 'vscode/1.96.0',
    'Editor-Plugin-Version': 'copilot/1.254.0',
    'User-Agent': 'GithubCopilot/1.254.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'Openai-Intent': 'conversation-panel',
    'Openai-Organization': 'github-copilot',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip,deflate,br',
    'Connection': 'keep-alive',
  };
}
