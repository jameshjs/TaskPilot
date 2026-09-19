import OpenAI from 'openai';
import type { Env } from './env';
import { HttpError } from './http';

export interface AskOptions<T> {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName: string;
  /** Validates and normalizes the parsed response; throw to reject it. */
  parse: (raw: unknown) => T;
  maxTokens?: number;
  temperature?: number;
}

/**
 * One call to OpenAI with a strict JSON schema, then our own validation on top:
 * structured outputs guarantee the shape, not that the content makes sense.
 */
export async function ask<T>(env: Env, opts: AskOptions<T>): Promise<T> {
  if (!env.OPENAI_API_KEY) throw new HttpError(503, 'OPENAI_API_KEY is not configured on the Worker');
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 900,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
      },
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 429) throw new HttpError(429, 'OpenAI rate limit reached — try again in a moment');
    throw new HttpError(502, `OpenAI request failed: ${(e as Error).message}`);
  }

  const text = completion.choices[0]?.message?.content;
  if (!text) throw new HttpError(502, 'OpenAI returned an empty response');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(502, 'OpenAI returned invalid JSON');
  }
  try {
    return opts.parse(parsed);
  } catch (e) {
    throw new HttpError(502, `OpenAI response failed validation: ${(e as Error).message}`);
  }
}

// ── Schema helpers ─────────────────────────────────────────────────────────

export const obj = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object',
  properties,
  required: required ?? Object.keys(properties),
  additionalProperties: false,
});
export const arr = (items: unknown, maxItems?: number) => ({ type: 'array', items, ...(maxItems ? { maxItems } : {}) });
export const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
export const enumOf = (values: readonly string[], description?: string) => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) });
export const num = (description?: string) => ({ type: 'number', ...(description ? { description } : {}) });
export const int = (description?: string) => ({ type: 'integer', ...(description ? { description } : {}) });
export const bool = (description?: string) => ({ type: 'boolean', ...(description ? { description } : {}) });
