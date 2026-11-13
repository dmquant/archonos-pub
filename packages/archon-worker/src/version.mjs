// Single source of truth for the ArchonOS release version.
//
// package.json is canonical; this module exists because the Cloudflare Worker
// bundle cannot read package.json at runtime. `test/version-single-source.test.mjs`
// fails if any of these drift apart.
export const ARCHON_VERSION = '0.5.0';
