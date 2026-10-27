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
