# Repository workflow

The user has requested that completed changes in this repository be committed
and pushed to `https://github.com/tpunt/Collector` as part of each task.

- Run the checks appropriate to the change before committing.
- Commit the task's completed changes with a clear message and push the task
  branch to `origin`, unless the user explicitly requests otherwise.
- Preserve unrelated user changes. Never force-push or rewrite published history
  unless explicitly requested.
- Keep credentials, browser profiles, databases, downloaded media and other
  runtime data out of Git. The default `.local-data/` directory is Git-ignored.
- If a commit or push is blocked, report the exact remaining step; do not claim
  that GitHub contains changes that were only saved locally.

# Content-source boundaries

Reddit is the first supported platform, not the only intended platform. Keep
this in mind when implementing features:

- Keep shared reader behavior (offline storage, media status, search, read
  tracking, cleanup and backups) independent of Reddit-specific assumptions.
- Keep site-specific extraction, authentication, pagination, availability
  evidence, media discovery and request policies behind collection boundaries.
  Other platforms may expose different capabilities; do not assume subreddits,
  Reddit IDs, comment trees or the same history controls everywhere.
- When adding another platform, namespace feed/item identities by platform and
  scope credentials and checkpoints appropriately. The current observation
  `source` value (`live` / `archive`) describes provenance, not platform identity.
- Evolve these boundaries as features need them. This direction does not require
  a speculative plugin framework, a broad rewrite or another source integration
  before the user requests one. Preserve current Reddit behavior and safeguards.
