import { type GitHubDeviceCodeResponse, type GitHubTokenResponse } from './types';

// Default Client ID for GitHub Copilot in VS Code
export const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

export async function startDeviceFlow(clientId: string = COPILOT_CLIENT_ID): Promise<GitHubDeviceCodeResponse> {
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: 'read:user', // minimal scope needed to get user details & token
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to start GitHub device flow: Status ${response.status} - ${text}`);
  }

  return await response.json() as GitHubDeviceCodeResponse;
}

export async function pollDeviceFlow(
  deviceCode: string,
  clientId: string = COPILOT_CLIENT_ID
): Promise<GitHubTokenResponse | { error: string }> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to poll GitHub token: Status ${response.status} - ${text}`);
  }

  const data = await response.json();
  if ('error' in data) {
    return { error: data.error };
  }

  return data as GitHubTokenResponse;
}
