export interface Env {
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  /** Optional shared secret; when set, every request must send `authorization: Bearer <it>`. */
  TASKPILOT_TOKEN?: string;
  SENTRY_DSN?: string;
  ALLOWED_ORIGIN: string;
  SESSIONS: DurableObjectNamespace;
  DB?: D1Database;
  COMPOSIO_API_KEY?: string;
  COMPOSIO_BASE_URL?: string;
}
