declare const __SENTRY_DSN__: string;

/**
 * Sentry is optional: with no DSN configured nothing is loaded and no data leaves the browser.
 * Session Replay is deliberately not enabled here — the side panel shows the user's tab titles.
 */
export function initTelemetry(): void {
  const dsn = typeof __SENTRY_DSN__ === 'string' ? __SENTRY_DSN__ : '';
  if (!dsn) return;
  void import('@sentry/browser').then((Sentry) => {
    Sentry.init({
      dsn,
      tracesSampleRate: 0.2,
      integrations: [Sentry.browserTracingIntegration()],
      beforeSend(event) {
        // Never ship URLs (they may carry query strings from the user's tabs).
        delete event.request;
        return event;
      },
    });
  });
}
