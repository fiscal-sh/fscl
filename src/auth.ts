import { posix as pathPosix } from 'node:path';

const AUTH_ERROR_PATTERNS = [
  'authentication failed',
  'invalid or expired session token',
  'token-expired',
  'unauthorized',
  'not logged in',
  'not-logged-in',
] as const;

export const AUTH_ERROR_CODE = 'not-logged-in';

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractFailureReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  return (
    asString(record.description) ??
    asString(record.reason) ??
    asString(record.message)
  );
}

function normalizeFailureReason(reason: string | undefined): string {
  if (!reason) {
    return 'unknown';
  }
  const compact = reason.replace(/\s+/g, ' ').trim();
  const cannotPostMatch = compact.match(/Cannot POST\s+\S+/i);
  if (cannotPostMatch) {
    return cannotPostMatch[0];
  }
  if (compact.length > 200) {
    return `${compact.slice(0, 197)}...`;
  }
  return compact;
}

function joinUrlPath(base: URL, path: string): string {
  const url = new URL(base.toString());
  url.pathname = pathPosix.join(url.pathname, path);
  return url.toString();
}

function resolveLoginUrls(serverURL: string): string[] {
  const trimmed = serverURL.trim();
  if (!trimmed) {
    throw new Error('Server URL is required.');
  }
  let base: URL;
  try {
    base = new URL(trimmed);
  } catch {
    throw new Error(`Invalid server URL: ${serverURL}`);
  }
  return [
    joinUrlPath(base, 'account/login'),
    joinUrlPath(base, 'login'),
  ];
}

export async function loginToServer(
  serverURL: string,
  password: string,
): Promise<string> {
  const urls = resolveLoginUrls(serverURL);
  let fallbackReason: string | undefined;

  for (const [index, url] of urls.entries()) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          loginMethod: 'password',
          password,
        }),
      });
    } catch {
      throw new LoginError('Login failed: network-failure');
    }

    const raw = await response.text();
    let payload: unknown = undefined;
    try {
      payload = raw ? (JSON.parse(raw) as unknown) : {};
    } catch {
      if (response.ok) {
        throw new LoginError('Login failed: parse-json');
      }
    }

    if (!response.ok) {
      const reason = normalizeFailureReason(
        extractFailureReason(payload) ?? asString(raw) ?? response.statusText,
      );
      if (response.status === 404 && index < urls.length - 1) {
        fallbackReason = reason;
        continue;
      }
      throw new LoginError(`Login failed: ${reason}`);
    }

    const result = (payload ?? {}) as Record<string, unknown>;
    if (result.status !== 'ok') {
      const reason = normalizeFailureReason(extractFailureReason(result));
      throw new LoginError(`Login failed: ${reason}`);
    }

    const data =
      result.data && typeof result.data === 'object'
        ? (result.data as Record<string, unknown>)
        : undefined;
    const token = asString(data?.token);
    if (!token) {
      throw new LoginError('Login failed: token missing from login response');
    }
    return token;
  }

  throw new LoginError(
    `Login failed: ${fallbackReason ?? 'login endpoint not found'}`,
  );
}

export function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof LoginError) {
    return false;
  }
  const message = error.message.toLowerCase();
  return AUTH_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}
