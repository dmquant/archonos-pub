// Single source of truth for the console's top-level views.
//
// Consumed by the inline app module (switchView + mobile tab bar), the shared
// interface layer (icons) and the test suite. Adding a view here is the only
// edit needed for it to appear in both the desktop spine and the mobile nav,
// and the tests compare this list against the markup so the two cannot drift.
//
// `labelKey` points at an existing data-i18n key in index.html / ui-copy.mjs.
// `mobileGroup: 'primary'` views get a permanent slot in the bottom tab bar;
// the rest live in the "More" sheet.

export const APP_VIEWS = Object.freeze([
  Object.freeze({
    id: 'workbench',
    labelKey: 'nav_chat_canvas',
    mobileLabelKey: 'mobile_nav_workbench',
    icon: 'message-square',
    mobileGroup: 'primary',
    title: 'Chat & Canvas Split Workbench',
  }),
  Object.freeze({
    id: 'seats',
    labelKey: 'nav_seats_crud',
    mobileLabelKey: 'mobile_nav_seats',
    icon: 'armchair',
    mobileGroup: 'primary',
    title: 'Seat Management (CRUD)',
  }),
  Object.freeze({
    id: 'artifacts',
    labelKey: 'nav_artifacts_mgr',
    mobileLabelKey: 'mobile_nav_artifacts',
    icon: 'package',
    mobileGroup: 'primary',
    title: 'Artifacts & Data Registry',
  }),
  Object.freeze({
    id: 'skills',
    labelKey: 'nav_skills_rsi',
    mobileLabelKey: 'mobile_nav_skills',
    icon: 'dna',
    mobileGroup: 'primary',
    title: 'Canonical Skills & Harness2 RSI',
  }),
  Object.freeze({
    id: 'schedules',
    labelKey: 'nav_schedules_mgr',
    icon: 'clock',
    mobileGroup: 'more',
    title: 'Scheduled Work & Daily Summaries Portal',
  }),
  Object.freeze({
    id: 'architect',
    labelKey: 'nav_architect_loop',
    icon: 'git-branch',
    mobileGroup: 'more',
    title: 'Antigravity (Codebase Session) ⇄ ArchonOS Seats Closed-Loop Bridge',
  }),
  Object.freeze({
    id: 'mcps',
    labelKey: 'nav_mcp_hub',
    icon: 'plug',
    mobileGroup: 'more',
    title: 'External MCP Servers & Grants',
  }),
  Object.freeze({
    id: 'hands',
    labelKey: 'nav_local_hands',
    icon: 'settings',
    mobileGroup: 'more',
    title: 'Local CLI Hands & Settings (claude, codex, agy, opencode, dsh)',
  }),
  Object.freeze({
    id: 'mesh',
    labelKey: 'nav_team_mesh',
    icon: 'users',
    mobileGroup: 'more',
    title:
      'Agora-Style Team Shared Workspaces, Topic Rooms, Colleague Access Keys & Cloudflare Remote Deployment',
  }),
]);

export const APP_VIEW_IDS = Object.freeze(APP_VIEWS.map((view) => view.id));

// Which bottom-bar tab represents a view: its own slot for primary views, or
// the "More" tab for overflow views. Used by the app and pinned by tests so
// exactly one tab can read as current.
export function mobileNavActiveTab(viewName, views = APP_VIEWS) {
  const view = views.find((entry) => entry.id === viewName);
  if (!view) return null;
  return view.mobileGroup === 'primary' ? view.id : 'more';
}

// Split the registry into the permanent tab-bar slots and the "More" sheet.
// Unknown/extra groups fall into "more" so a typo can never hide a view.
export function mobileNavGroups(views = APP_VIEWS) {
  const primary = [];
  const more = [];
  for (const view of views) {
    if (view.mobileGroup === 'primary') primary.push(view.id);
    else more.push(view.id);
  }
  return { primary, more };
}