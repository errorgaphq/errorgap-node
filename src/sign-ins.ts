import type { Configuration } from "./configuration.js";
import { VERSION } from "./version.js";

/** What happened. Anything else is dropped. */
export type SignInOutcome = "success" | "failure" | "password_reset" | "mfa_failure" | "locked";

export const SIGN_IN_OUTCOMES: readonly SignInOutcome[] = [
  "success",
  "failure",
  "password_reset",
  "mfa_failure",
  "locked",
];

/** A Node, Express or Fastify request: only these fields are read. */
export interface SignInRequest {
  ip?: string;
  method?: string;
  url?: string;
  originalUrl?: string;
  path?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined };
}

export interface SignInOptions {
  /** How the user is named: email, username or id. Never a password. */
  user?: string | number | null;
  /** Fills in the IP, user agent and path. */
  req?: SignInRequest;
  ip?: string;
  userAgent?: string;
  /** "POST /users/sign_in". */
  path?: string;
  /** password · sso · magic_link · … */
  method?: string;
  occurredAt?: Date;
  sync?: boolean;
}

export interface SignInEvent {
  occurred_at: string;
  outcome: SignInOutcome;
  user?: string;
  ip?: string;
  user_agent?: string;
  path?: string;
  method?: string;
}

function header(req: SignInRequest, name: string): string | undefined {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The event to send, or null when it should not be sent. */
export function buildSignIn(outcome: string, options: SignInOptions): SignInEvent | null {
  if (!SIGN_IN_OUTCOMES.includes(outcome as SignInOutcome)) return null;
  const req = options.req;
  // Express and Fastify resolve `ip` through their trust-proxy settings.
  const ip = options.ip ?? req?.ip ?? req?.socket?.remoteAddress;
  const userAgent = options.userAgent ?? (req ? header(req, "user-agent") : undefined);
  const rawPath = req ? (req.path ?? (req.originalUrl ?? req.url ?? "").split("?")[0]) : undefined;
  const path = options.path ?? (req?.method && rawPath ? `${req.method} ${rawPath}` : undefined);
  const event: SignInEvent = {
    occurred_at: (options.occurredAt ?? new Date()).toISOString(),
    outcome: outcome as SignInOutcome,
  };
  const user = options.user == null ? "" : String(options.user).trim();
  if (user) event.user = user;
  if (ip) event.ip = ip;
  if (userAgent) event.user_agent = userAgent.slice(0, 512);
  if (path) event.path = path.slice(0, 200);
  if (options.method) event.method = options.method;
  return event;
}

export function signInPayload(event: SignInEvent, configuration: Configuration) {
  return {
    app: configuration.appName ?? configuration.projectSlug,
    environment: configuration.environment,
    sdk: `errorgap-node ${VERSION}`,
    events: [event],
  };
}
