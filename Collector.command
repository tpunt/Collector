#!/bin/zsh
# Double-click in Finder. No packages or runtimes are installed by this script.
collector_root="${0:A:h}"
cd "$collector_root" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent >/dev/null 2>&1
fi
if ! command -v node >/dev/null 2>&1; then
  print 'Collector needs Node 25.3 or newer. Install Node, then run npm ci in this checkout.'
  read '?Press Return to close. '
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>25||(a===25&&b>=3)?0:1)' || {
  print 'Collector needs Node 25.3 or newer. Run nvm install && nvm use in this checkout.'
  read '?Press Return to close. '
  exit 1
}
node src/launcher.ts
collector_result=$?
if (( collector_result != 0 )); then
  read '?Press Return to close. '
fi
exit "$collector_result"
