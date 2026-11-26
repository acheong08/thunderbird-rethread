#!/usr/bin/env bash
# End-to-end test: real Thunderbird, throwaway profile, headless.
# Usage: test/e2e/run.sh /path/to/Thunderbird.app/Contents/MacOS/thunderbird
set -euo pipefail
TB="${1:?path to thunderbird binary}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../../src"
WORK="$(mktemp -d /tmp/rethread-e2e.XXXXXX)"
PROFILE="$WORK/profile"
ADDON="$WORK/addon"
mkdir -p "$PROFILE/extensions" "$ADDON/experiment"

cp "$SRC"/* "$ADDON/"
cp "$HERE/selftest.js" "$ADDON/"
cp "$HERE/experiment/"* "$ADDON/experiment/"
python3 - "$ADDON/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]; m = json.load(open(p))
m["background"]["scripts"].append("selftest.js")
m["permissions"].append("accountsFolders")  # the test creates its own folder
m["experiment_apis"] = {"rethreadTest": {"schema": "experiment/schema.json", "parent": {
    "scopes": ["addon_parent"], "paths": [["rethreadTest"]], "script": "experiment/implementation.js"}}}
json.dump(m, open(p, "w"), indent=1)
PY
(cd "$ADDON" && zip -qr "$PROFILE/extensions/rethread@duti.dev.xpi" .)

cat > "$PROFILE/user.js" <<'EOF'
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.experiments.enabled", true);
user_pref("mail.shell.checkDefaultClient", false);
user_pref("mail.provider.suppress_dialog_on_startup", true);
user_pref("mail.spotlight.firstRunDone", true);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("app.update.disabledForTesting", true);
user_pref("devtools.console.stdout.chrome", true);
user_pref("devtools.console.stdout.content", true);
user_pref("mail.accountmanager.accounts", "account1");
user_pref("mail.accountmanager.localfoldersserver", "server1");
user_pref("mail.account.account1.server", "server1");
user_pref("mail.server.server1.type", "none");
user_pref("mail.server.server1.hostname", "Local Folders");
user_pref("mail.server.server1.userName", "nobody");
user_pref("mail.server.server1.name", "Local Folders");
user_pref("mail.server.server1.directory-rel", "[ProfD]Mail/Local Folders");
EOF

REPORT="$PROFILE/rethread-report.json"
"$TB" -headless -no-remote -profile "$PROFILE" >"$WORK/tb.log" 2>&1 &
TBPID=$!
for _ in $(seq 1 120); do [ -s "$REPORT" ] && break; sleep 1; done
kill "$TBPID" 2>/dev/null || true
wait 2>/dev/null || true

if [ ! -s "$REPORT" ]; then
  echo "No report after 120s. Thunderbird log tail:"; tail -40 "$WORK/tb.log"; exit 2
fi
python3 - "$REPORT" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print("\n".join(r["log"]))
print(f"\n{r['failures']} failure(s)")
sys.exit(1 if r["failures"] else 0)
PY
