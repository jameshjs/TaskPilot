import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Broadcast, BroadcastName } from '../shared/rpc';

/** Re-run `cb` whenever the service worker says tabs or task state changed. */
export function useBroadcast(names: BroadcastName[], cb: () => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const listener = (msg: Broadcast) => {
      if (msg?.type === 'broadcast' && names.includes(msg.name)) ref.current();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names.join(',')]);
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useLoad<T>(fn: () => Promise<T>, names: BroadcastName[] = []): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const reload = useCallback(() => {
    const mine = ++seq.current;
    fnRef.current().then(
      (d) => {
        if (mine !== seq.current) return; // a newer load superseded this one
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  }, []);

  useEffect(reload, [reload]);
  useBroadcast(names, reload);
  return { data, error, loading, reload };
}

// ── Toasts ─────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'ok';
}
interface ToastApi {
  notify: (text: string, kind?: Toast['kind']) => void;
}
const ToastCtx = createContext<ToastApi>({ notify: () => undefined });
export const useToast = (): ToastApi => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const notify = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={{ notify }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wraps an async action: tracks busy state and turns thrown errors into a toast. */
export function useAction() {
  const { notify } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>, okMessage?: (r: T) => string): Promise<T | undefined> => {
      setBusy(label);
      try {
        const r = await fn();
        if (okMessage) notify(okMessage(r), 'ok');
        return r;
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), 'error');
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [notify],
  );
  return { run, busy };
}
