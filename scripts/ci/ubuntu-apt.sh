#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
# Both HTTPS mirrors are registered Ubuntu archives:
# https://launchpad.net/ubuntu/+archivemirrors
# Keep the runner's suites, components and Signed-By keyring. Apt verifies the
# publisher's signatures and metadata validity at either mirror.
sudo tee /etc/apt/hyper-ci-mirrors.txt >/dev/null <<'EOF'
https://mirror.pilotfiber.com/ubuntu/	priority:1
https://mirror.fcix.net/ubuntu/	priority:2
https://archive.ubuntu.com/ubuntu/	priority:3
EOF
for apt_source in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
  if [ -f "$apt_source" ]; then
    sudo sed -i -E \
      -e 's#https?://(azure[.]archive|archive|security)[.]ubuntu[.]com/ubuntu/?#mirror+file:/etc/apt/hyper-ci-mirrors.txt#g' \
      -e 's#mirror[+]file:/etc/apt/apt-mirrors[.]txt#mirror+file:/etc/apt/hyper-ci-mirrors.txt#g' "$apt_source"
    grep -E '^URIs:|^deb ' "$apt_source" || true
  fi
done
sudo tee /etc/apt/apt.conf.d/zz-hyper-ci-acquire >/dev/null <<'EOF'
Acquire::Retries "1";
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
EOF
