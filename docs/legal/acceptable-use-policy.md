# Legal — canonical location

The live **Terms of Use** (which include the Acceptable Use terms) and **Privacy
Policy** are the source of truth for what users agree to. They render in the SPA
at `/#/terms` and `/#/privacy`; the markup lives in `projects/worker/public/index.html`.

Operational notes:

- The accept-screen (shown after login until accepted) links to `/#/terms` and
  records acceptance via `POST /v1/auth/accept-tos` (version + timestamp + IP +
  user-agent, logged append-only in `tos_acceptances`).
- **Bump `TOS_VERSION`** in `projects/worker/src/auth-routes.ts` whenever the
  Terms change materially — users whose accepted version is older are re-prompted.
  Keep the "Version" line on the Terms page in sync.
- This is a good-faith, self-authored policy, not attorney-reviewed. If a budget
  for legal review appears, have the Terms + Privacy text vetted and set a real
  governing-law clause and support contact.
