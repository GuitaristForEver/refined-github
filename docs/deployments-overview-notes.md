# Deployments Overview (Refined GitHub)

This document captures the current status of the Deployments Overview feature and a backlog of future improvements.

Last updated: 2025-08-09 21:51 UTC

## Current status
- Feature renders a Deployments section below the repo nav with a header: "Deployments: <Primary Env>".
- Environments are shown as cards in a responsive grid.
- Cards include:
  - Environment name
  - Status icon and label
  - Branch/ref (or SHA short) badge
  - Time ago of latest deployment status (fallback to deployment created time)
  - Optional link overlay to environment_url
- Data fetching:
  - Primary via GraphQL (inline query), falls back to REST if blocked by SAML/org policy.
  - Groups deployments by environment and keeps the most recent.
  - 5-minute in-memory cache per repo.
- Styling:
  - GitHub-native subtle filled backgrounds by state (success, failure/error, pending/queued, in_progress, inactive/unknown).
  - State-colored icon/label with neutral body text for readability.
  - Dark mode compatible; uses Primer tokens with fallbacks. Forced specificity to avoid being overridden by upstream styles.
- Integration touches:
  - Adds small pills in PR/release contexts to show where that PR/tag is deployed.

## Recently completed
- Replaced pills layout with card-based layout to match GitHub deployments feel.
- Implemented createEnvironmentCard and related CSS.
- Fixed icons import and types; build passes.
- Improved error handling and API fallbacks.
- Adjusted colors from strong “emphasis” to “muted/subtle” to better match GitHub tone.

## Backlog (prioritized)
1) Visual polish and consistency
- Add compact status chip next to environment name (e.g., [✓ success], [⟳ in progress])
- Show commit short SHA and link to commit when available
- Make card header clickable to environment_url; keep overlay only for cards that have a URL
- Add tooltip titles with absolute timestamps
- Add skeleton/loading state while fetching

2) Data richness and accuracy
- Show last N statuses in a mini-timeline/hover popover (success → in_progress → success, etc.)
- Surface actor (who deployed) and deployment creator when available
- Detect and mark the primary environment more robustly (repo settings, heuristics, popular names)
- Support multiple deployments per environment (e.g., multiple clusters/regions) with a collapsible list

3) Filtering and controls
- Filter by state (Only failed, Only active, etc.)
- Group by category (Prod/Non-prod) or custom ordering (Prod, Staging, UAT, Preview)
- Compact mode toggle (smaller cards, 2 lines)

4) Navigation and deep links
- Link to GitHub Deployments page (environment’s history) from the card
- If GitHub Actions workflow URL is present via log_url, expose an “Open Logs” secondary action
- Keyboard navigation between cards

5) Performance and resilience
- Persist cache across soft navigation (page transitions) for a short time
- Backoff/retry strategy on transient REST errors
- Guard against rate limiting (show "data temporarily unavailable")

6) Accessibility
- Ensure proper roles/landmarks and aria-labels on links and icons
- Focus ring and tab order polish; high-contrast friendly tokens

7) Configurability
- User option to choose style: Subtle vs Strong emphasis backgrounds
- Per-repo environment aliasing/ordering (e.g., treat "production-eu" as Prod)

8) Testing
- Unit tests for mappers (GraphQL/REST → Environment model)
- Visual regression tests for key states (success, failure, queued, in_progress)

## Notes / Next session checklist
- Confirm subtle colors look acceptable across GitHub themes (light, dark, dimmed)
- Verify icon "currentColor" approach works for all octicons used
- Consider trimming padding on mobile to fit more cards per row

## Known limitations
- Some orgs may block both GraphQL and REST for deployments; feature hides itself in that case.
- Environment detection relies on naming heuristics for the “primary” marker.

