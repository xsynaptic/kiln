import { homedir } from "node:os";

import type { SlotToolchain } from "./toolchain.ts";

import { githubRemoteUrl, kilnConfig } from "../config/config.ts";
import { hostLinkLines, toolProvisionLines } from "./guest-tools.ts";
import { bashMaxTimeoutMs, pushGateShimLines, singleQuote } from "./vm.ts";

// Backups stay off, because bd registers them on the server under one fixed name, which a slot would point into its VM
// A heredoc rather than printf, because inside the String.raw script a printf `\n` stays as two characters
/** @internal */
export function beadsLocalConfigScript(profile: string): string {
  return [
    "cat > .beads/config.local.yaml <<'YAML'",
    `actor: ${JSON.stringify(profile)}`,
    "backup:",
    "    enabled: false",
    "YAML",
  ].join("\n");
}

// Under load, Lima's clock sync steps the guest clock backwards, and tests that compare against `now()` see time reverse
// Removing CAP_SYS_TIME from the guest agent is the only way to turn that sync off; the short poll limit covers catch-up after the host sleeps
export function guestClockScript(): string {
  return String.raw`
set -euo pipefail

RESTART=""
write_if_changed() {
  if [ "$(sudo cat "$2" 2>/dev/null)" != "$3" ]; then
    sudo mkdir -p "$(dirname "$2")"
    printf '%s\n' "$3" | sudo tee "$2" >/dev/null
    RESTART="$RESTART $1"
  fi
}
write_if_changed lima-guestagent /etc/systemd/system/lima-guestagent.service.d/kiln-clock.conf "[Service]
CapabilityBoundingSet=~CAP_SYS_TIME"
write_if_changed systemd-timesyncd /etc/systemd/timesyncd.conf.d/kiln-clock.conf "[Time]
PollIntervalMaxSec=64"
if [ -n "$RESTART" ]; then
  sudo systemctl daemon-reload
  sudo systemctl restart $RESTART
fi

# CAP_SYS_TIME is capability bit 25
AGENT_PID=$(systemctl show -p MainPID --value lima-guestagent)
CAP_BOUNDING=$(awk '/^CapBnd:/ { print $2 }' "/proc/$AGENT_PID/status")
[ $(( 0x$CAP_BOUNDING >> 25 & 1 )) -eq 0 ] || { echo "lima-guestagent still holds CAP_SYS_TIME" >&2; exit 1; }
systemctl is-active --quiet systemd-timesyncd || { echo "systemd-timesyncd is not running" >&2; exit 1; }

python3 - <<'PY'
import sys, time
real, raw = time.CLOCK_REALTIME, time.CLOCK_MONOTONIC_RAW
end = time.clock_gettime(raw) + 12
last = (time.clock_gettime(raw), time.clock_gettime(real))
while last[0] < end:
    time.sleep(0.02)
    now = (time.clock_gettime(raw), time.clock_gettime(real))
    step = (now[1] - last[1]) - (now[0] - last[0])
    if step < -0.005:
        sys.exit("the guest clock stepped back %.0fms" % (-1000 * step))
    last = now
PY
echo "PROVISION_CLOCK_OK"
`;
}

export function guestBaseScript(toolchain: SlotToolchain): string {
  return String.raw`
set -euo pipefail

# No \${...} here: this script is a JavaScript template, where \${} would be filled in before bash sees it
MISSING=""
command -v xz     >/dev/null 2>&1 || MISSING="$MISSING xz-utils"
command -v tmux   >/dev/null 2>&1 || MISSING="$MISSING tmux"
command -v jq     >/dev/null 2>&1 || MISSING="$MISSING jq"
command -v tree   >/dev/null 2>&1 || MISSING="$MISSING tree"
command -v fdfind >/dev/null 2>&1 || MISSING="$MISSING fd-find"
if [ -n "$MISSING" ]; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq $MISSING
fi
command -v fd >/dev/null 2>&1 || sudo ln -sf "$(command -v fdfind)" /usr/local/bin/fd 2>/dev/null || true

if ! command -v gh >/dev/null 2>&1; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq gh
fi

# Same version as the host, so both read the same schema
if [ "$(bd version 2>/dev/null | awk '{print $3}')" != "${toolchain.beads}" ]; then
  case "$(uname -m)" in
    aarch64) BD_ARCH=arm64 ;;
    x86_64) BD_ARCH=amd64 ;;
    *) echo "unsupported guest arch: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "installing beads v${toolchain.beads}"
  curl -fsSL "https://github.com/gastownhall/beads/releases/download/v${toolchain.beads}/beads_${toolchain.beads}_linux_$BD_ARCH.tar.gz" | sudo tar -xz -C /usr/local/bin bd
fi

if [ "$(gitleaks version 2>/dev/null)" != "${toolchain.gitleaks}" ]; then
  case "$(uname -m)" in
    aarch64) GITLEAKS_ARCH=arm64 ;;
    x86_64) GITLEAKS_ARCH=x64 ;;
    *) echo "unsupported guest arch: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "installing gitleaks v${toolchain.gitleaks}"
  curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${toolchain.gitleaks}/gitleaks_${toolchain.gitleaks}_linux_$GITLEAKS_ARCH.tar.gz" | sudo tar -xz -C /usr/local/bin gitleaks
fi

if [ "$("$HOME/.local/bin/claude" --version 2>/dev/null | awk '{print $1}')" != "${toolchain.claude}" ]; then
  echo "installing claude v${toolchain.claude}"
  if [ -x "$HOME/.local/bin/claude" ]; then
    "$HOME/.local/bin/claude" install "${toolchain.claude}" >/dev/null
  else
    curl -fsSL https://claude.ai/install.sh | bash -s "${toolchain.claude}" >/dev/null
  fi
fi
# The installer keeps every old release, and the root disk is small
find "$HOME/.local/share/claude/versions" -mindepth 1 -maxdepth 1 ! -name "${toolchain.claude}" -exec rm -rf {} +
grep -qs '\.local/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"

# Ubuntu's user-namespace restriction breaks chromium's sandbox; lifting it is safer than --no-sandbox
echo "kernel.apparmor_restrict_unprivileged_userns = 0" | sudo tee /etc/sysctl.d/99-chromium-userns.conf >/dev/null
# The default overcommit refuses any single reservation larger than RAM, which some tools ask for and never use
echo "vm.overcommit_memory = 1" | sudo tee /etc/sysctl.d/99-overcommit.conf >/dev/null
sudo sysctl --system >/dev/null

echo "PROVISION_BASE_OK"
`;
}

export function guestProjectScript(profile: string, repoRoot: string, toolchain: SlotToolchain): string {
  const { node: nodeVersion, pnpm: pnpmVersion } = toolchain;
  const linkLines = hostLinkLines(kilnConfig.guest.hostLinks, repoRoot);

  return String.raw`
set -euo pipefail

# /mnt/lima-cidata also matches, so only the writable ext4 mount counts as the data disk
WORK_ROOT=$(findmnt -rn -o TARGET,FSTYPE,OPTIONS | awk '$1 ~ /^\/mnt\/lima-/ && $2 == "ext4" && $3 ~ /(^|,)rw(,|$)/ { print $1; exit }')
[ -n "$WORK_ROOT" ] || { echo "data disk not mounted under /mnt/lima-*" >&2; exit 1; }
CLONE="$WORK_ROOT/work/${kilnConfig.identity.cloneDirName}"

if ! command -v node >/dev/null 2>&1 || [ "$(node -v)" != "v${nodeVersion}" ]; then
  case "$(uname -m)" in
    aarch64) NODE_ARCH=arm64 ;;
    x86_64) NODE_ARCH=x64 ;;
    *) echo "unsupported guest arch: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "installing node v${nodeVersion}"
  curl -fsSL "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz
  sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm /tmp/node.tar.xz
fi

if [ "$(pnpm --version 2>/dev/null)" != "${pnpmVersion}" ]; then
  echo "installing pnpm v${pnpmVersion}"
  sudo npm install -g "pnpm@${pnpmVersion}"
fi

sudo mkdir -p "$WORK_ROOT/work"
sudo chown "$(id -u):$(id -g)" "$WORK_ROOT/work"
if [ ! -d "$CLONE/.git" ]; then
  git clone ${JSON.stringify(repoRoot)} "$CLONE"
fi
cd "$CLONE"
# Not called origin, so a habitual 'git pull origin' never pulls from the host's own checkout
git remote get-url host-ro >/dev/null 2>&1 || git remote rename origin host-ro
git fetch --quiet host-ro main
git checkout --quiet main
git reset --hard --quiet host-ro/main
git config --local user.name ${JSON.stringify(profile)}
git config --local user.email ${singleQuote(kilnConfig.identity.machineUser.email)}

# set-url when the remote exists, so a renamed repo reaches an existing clone
git remote add github ${JSON.stringify(githubRemoteUrl())} 2>/dev/null || git remote set-url github ${JSON.stringify(githubRemoteUrl())}
git remote add origin ${JSON.stringify(githubRemoteUrl())} 2>/dev/null || git remote set-url origin ${JSON.stringify(githubRemoteUrl())}
git config --local branch.main.remote github
git config --local branch.main.merge refs/heads/main
git config --local remote.github.gh-resolved base
git config --local credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'

# The contributor role and 0700 keep bd from warning
git config --local beads.role contributor
if [ -d .beads ]; then
  chmod 700 .beads
  # A bd call that can't reach the server creates an empty local store, which every later call then reads
  rm -rf .beads/dolt .beads/embeddeddolt .beads/dolt-server.lock .beads/dolt-server.pid .beads/dolt-server.port
  ${beadsLocalConfigScript(profile)}
fi

# Accept every first-run dialog up front, so no session stalls on one
CLONE_PATH="$CLONE" node <<'NODE'
const fs = require("fs");
const file = process.env.HOME + "/.claude.json";
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
config.projects = config.projects || {};
const workspace = (config.projects[process.env.CLONE_PATH] ||= {});
workspace.hasTrustDialogAccepted = true;
config.hasCompletedOnboarding = true;
fs.writeFileSync(file, JSON.stringify(config));
const settingsDir = process.env.HOME + "/.claude";
fs.mkdirSync(settingsDir, { recursive: true });
const settingsFile = settingsDir + "/settings.json";
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
settings.theme = settings.theme || "dark";
settings.skipDangerousModePermissionPrompt = true;
settings.model = settings.model || "opus";
settings.statusLine = settings.statusLine || { type: "command", command: "~/.claude/statusline.sh" };
settings.env = Object.assign({}, settings.env, { BASH_MAX_TIMEOUT_MS: "${bashMaxTimeoutMs}" });
fs.writeFileSync(settingsFile, JSON.stringify(settings));
NODE

${linkLines.join("\n")}

pnpm install
${pushGateShimLines.join("\n")}
${toolProvisionLines(kilnConfig.guest)}
echo "PROVISION_OK $CLONE"
`;
}

// A refused write is the real test, because a mount can be flagged writable while virtiofsd still refuses every write
export function boundaryDrillScript(repoRoot: string): string {
  return `
set -u
HOST_REPO=${JSON.stringify(repoRoot)}
HOST_HOME=${JSON.stringify(homedir())}
FAIL=0
ok() { echo "  ok:   $1"; }
bad() { echo "  FAIL: $1"; FAIL=1; }

echo "  host mounts visible in the guest:"
findmnt -rn -t virtiofs -o TARGET,OPTIONS | sed 's/^/    /'

if findmnt -rn -t virtiofs -o TARGET | grep -qx "$HOST_REPO"; then
  ok "checkout mounted at $HOST_REPO"
else
  bad "checkout mount missing"
fi
if findmnt -rn -t virtiofs -o TARGET,OPTIONS | awk -v t="$HOST_REPO" '$1 == t && $2 ~ /(^|,)ro(,|$)/ { found = 1 } END { exit !found }'; then
  ok "checkout mount flagged ro"
else
  echo "  note: checkout mount flags show rw (cosmetic on some boots); the write-refusal probes below are the real check"
fi

EXTRA=$(findmnt -rn -t virtiofs -o TARGET | grep -v -e "^$HOST_REPO$" -e '^/tmp/colima$' -e '^/tmp/lima$' || true)
if [ -z "$EXTRA" ]; then ok "no unexpected host mounts"; else bad "unexpected host mounts: $EXTRA"; fi

if touch "$HOST_REPO/.agent-drill" 2>/dev/null; then rm -f "$HOST_REPO/.agent-drill"; bad "checkout mount accepted a write"; else ok "checkout mount refuses writes"; fi
if touch "$HOST_REPO/.git/agent-drill" 2>/dev/null; then rm -f "$HOST_REPO/.git/agent-drill"; bad "host .git accepted a write"; else ok "host .git refuses writes"; fi
if sudo -n touch "$HOST_REPO/.agent-drill" 2>/dev/null; then sudo -n rm -f "$HOST_REPO/.agent-drill"; bad "checkout mount accepted a sudo write"; else ok "checkout mount refuses sudo writes"; fi
if sudo -n touch "$HOST_REPO/.git/agent-drill" 2>/dev/null; then sudo -n rm -f "$HOST_REPO/.git/agent-drill"; bad "host .git accepted a sudo write"; else ok "host .git refuses sudo writes"; fi
if [ -e "$HOST_HOME/.ssh" ]; then bad "host home is visible ($HOST_HOME/.ssh exists)"; else ok "host home is not visible"; fi
if touch "$HOST_HOME/.agent-drill" 2>/dev/null; then rm -f "$HOST_HOME/.agent-drill"; bad "host home accepted a write"; else ok "host home refuses writes"; fi

exit $FAIL
`;
}
