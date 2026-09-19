import { HttpError } from './http';

export function str(v: unknown, field: string, max = 4000): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  if (!t) throw new HttpError(400, `${field} is required`);
  return t.slice(0, max);
}

export function optStr(v: unknown, max = 4000): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

export function arrayOf<T>(v: unknown, field: string, max: number, map: (item: unknown, i: number) => T): T[] {
  if (!Array.isArray(v)) throw new HttpError(400, `${field} must be an array`);
  return v.slice(0, max).map(map);
}

export function clamp01(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(1, Math.max(0, n));
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Tab metadata from the extension: ids must be integers, text is length-capped. */
export function tabList(v: unknown, field: string, max = 120): { id: number; title: string; url: string; summary?: string }[] {
  return arrayOf(v, field, max, (item) => {
    const t = item as Record<string, unknown>;
    if (typeof t?.id !== 'number' || !Number.isInteger(t.id)) throw new HttpError(400, `${field}[].id must be an integer`);
    return {
      id: t.id,
      title: (typeof t.title === 'string' ? t.title : '').slice(0, 160),
      url: (typeof t.url === 'string' ? t.url : '').slice(0, 300),
      summary: optStr(t.summary, 400),
    };
  });
}
