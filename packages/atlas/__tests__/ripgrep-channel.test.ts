import { describe, it, expect } from 'vitest';
import { extractGrepTerms, shouldSkipGrep } from '../src/search/ripgrep-channel';

// Parser check for the third seed channel (atlas-extension-plan note #7).
// The rg output splitter and channel-fusion path can't be unit-tested without
// a live rg binary + a QueryBuilder — but extractGrepTerms IS the entry we
// most need to lock down: too-short tokens flood rg, and duplicate tokens
// waste the pattern budget.
describe('extractGrepTerms', () => {
  it('prefers identifier-shaped tokens over surrounding prose', () => {
    // `Beta` and `Automations` are identifier-shaped (capitalized) → the prose
    // words `badge`, `on`, `the`, `button` are DROPPED so grep sees the two
    // discriminative tokens instead of the whole English sentence.
    const terms = extractGrepTerms('Beta badge on the Automations button');
    expect(terms).toEqual(['Beta', 'Automations']);
  });

  it('keeps hyphenated / snake_case identifiers as separate tokens', () => {
    const terms = extractGrepTerms('sidebar-nav-badge span');
    // hyphen splits into parts, each part carries a hyphen-shape signal.
    expect(terms).toContain('sidebar');
    expect(terms).toContain('nav');
    expect(terms).toContain('badge');
  });

  it('filters stop-words from a prose-only query', () => {
    // No identifier-shaped tokens → falls through to stop-word filter. `the`,
    // `too`, `many` drop; `onboarding`/`welcome`/`workspace`/`flow` survive.
    const terms = extractGrepTerms('onboarding welcome workspace flow');
    expect(terms).toEqual(['onboarding', 'welcome', 'workspace', 'flow']);

    const noisy = extractGrepTerms('the too many requests');
    expect(noisy).toEqual(['requests']); // only word not in STOP_WORDS
  });

  it('caps at 6 patterns so a long question does not spam rg', () => {
    const terms = extractGrepTerms(
      'alpha beta gamma delta epsilon zeta eta theta iota',
    );
    expect(terms.length).toBeLessThanOrEqual(6);
  });

  it('returns [] for a query with no groupable identifiers', () => {
    expect(extractGrepTerms('!!! ?? ==')).toEqual([]);
    expect(extractGrepTerms('a b c')).toEqual([]); // all <3 chars
    expect(extractGrepTerms('the and for with')).toEqual([]); // all stop-words
  });
});

describe('shouldSkipGrep', () => {
  it('skips identifier-heavy queries (FTS is authoritative)', () => {
    expect(shouldSkipGrep('WelcomePage Onboarding workspaceStore')).toBe(true);
    expect(shouldSkipGrep('findRelevantContext computeGrepSeeds')).toBe(true);
    expect(shouldSkipGrep('parse_config init_db')).toBe(true);
  });

  it('runs grep on prose queries where UI copy could hide the target', () => {
    expect(shouldSkipGrep('rate limiting prevent too many requests')).toBe(false);
    expect(shouldSkipGrep('onboarding welcome workspace flow')).toBe(false);
    expect(shouldSkipGrep('fit to screen')).toBe(false);
  });

  it('runs grep on mixed prose+identifier queries', () => {
    // One identifier ("Beta"), four prose words → not identifier-heavy.
    expect(shouldSkipGrep('Beta badge on the Automations button')).toBe(false);
  });

  it('runs grep on a single-token query (indeterminate intent)', () => {
    expect(shouldSkipGrep('Onboarding')).toBe(false);
    expect(shouldSkipGrep('onboarding')).toBe(false);
  });
});
