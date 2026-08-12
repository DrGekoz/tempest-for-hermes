import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getStaticTools } from '../src/mcp/tools';

describe('DEFAULT_MCP_TOOLS surface', () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env.ATLAS_MCP_TOOLS; delete process.env.ATLAS_MCP_TOOLS; });
  afterEach(() => { if (prev === undefined) delete process.env.ATLAS_MCP_TOOLS; else process.env.ATLAS_MCP_TOOLS = prev; });

  it('exposes atlas_explore + rung-3 asset tools by default', () => {
    // Regression: only atlas_explore was listed pre-fix, so agents could not
    // discover atlas_assets / atlas_asset_content / atlas_semantic_search even
    // though the handlers had shipped in Rung 3.
    const names = getStaticTools().map((t) => t.name).sort();
    expect(names).toEqual([
      'atlas_asset_content',
      'atlas_assets',
      'atlas_explore',
      'atlas_semantic_search',
    ]);
  });
});
