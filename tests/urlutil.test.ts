import { describe, expect, it } from 'vitest';
import { matchesUrlPattern } from '../src/shared/urlutil';

describe('matchesUrlPattern', () => {
  it('matches a bare host and its subdomains', () => {
    expect(matchesUrlPattern('https://reddit.com/r/all', ['reddit.com'])).toBe(true);
    expect(matchesUrlPattern('https://old.reddit.com/r/all', ['reddit.com'])).toBe(true);
    expect(matchesUrlPattern('https://www.reddit.com/', ['reddit.com'])).toBe(true);
    expect(matchesUrlPattern('https://notreddit.com/', ['reddit.com'])).toBe(false);
  });

  it('scopes a pattern to a path prefix when one is given', () => {
    const list = ['youtube.com/shorts'];
    expect(matchesUrlPattern('https://youtube.com/shorts/abc123', list)).toBe(true);
    expect(matchesUrlPattern('https://www.youtube.com/shorts', list)).toBe(true);
    expect(matchesUrlPattern('https://youtube.com/watch?v=abc', list)).toBe(false);
  });

  it('only matches a path prefix on a segment boundary', () => {
    expect(matchesUrlPattern('https://reddit.com/r/memesearch', ['reddit.com/r/memes'])).toBe(false);
    expect(matchesUrlPattern('https://reddit.com/r/memes/top', ['reddit.com/r/memes'])).toBe(true);
  });

  it('ignores scheme, www, trailing slashes and case in the pattern', () => {
    const variants = ['https://www.Reddit.com/', 'reddit.com', 'REDDIT.COM/'];
    for (const v of variants) expect(matchesUrlPattern('https://reddit.com/r/all', [v])).toBe(true);
  });

  it('ignores the query string, so tracking params cannot dodge the list', () => {
    expect(matchesUrlPattern('https://youtube.com/shorts/x?utm_source=mail', ['youtube.com/shorts'])).toBe(true);
  });

  it('is false for an empty list, blank entries and unparseable urls', () => {
    expect(matchesUrlPattern('https://reddit.com', [])).toBe(false);
    expect(matchesUrlPattern('https://reddit.com', ['  ', ''])).toBe(false);
    expect(matchesUrlPattern('not a url', ['reddit.com'])).toBe(false);
  });
});
