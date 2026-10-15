import { withBase } from '@/lib/host';

class ApiClient {
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(withBase(path), {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    // Let the auth gate re-evaluate as soon as any call is rejected, so an
    // expired or revoked session drops back to the login screen immediately.
    if (res.status === 401 || res.status === 403) {
      window.dispatchEvent(new Event('nougate:unauthorized'));
    }

    if (!res.ok) {
      const text = await res.text();
      let message = 'An error occurred';
      try {
        const json = JSON.parse(text);
        message = json.error || json.message || message;
      } catch {
        message = text || message;
      }
      throw new Error(message);
    }

    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return null as unknown as T;
    }

    try {
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await res.json();
      }
      return (await res.text()) as unknown as T;
    } catch {
      return null as unknown as T;
    }
  }

  get<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: any, options?: RequestInit): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  patch<T>(path: string, body?: any, options?: RequestInit): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  delete<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }
}

export const api = new ApiClient();
