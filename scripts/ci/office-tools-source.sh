#!/usr/bin/env bash
set -euo pipefail
# The batch image is built/verified by office-batch.sh first. Only the CI loopback API reaches it.
container="hyper-office-product-test-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$container" --init --network hyper-office-ci \
  --publish 127.0.0.1:3123:3123 --memory=768m --memory-swap=768m --cpus=1 \
  --pids-limit=128 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=1770 \
  hyper-workspace-office-batch:test >/dev/null
for attempt in $(seq 1 30); do
  if curl --silent --fail --max-time 2 http://127.0.0.1:3123/health >/dev/null; then break; fi
  if [ "$attempt" = 30 ]; then echo 'Office batch service did not become ready' >&2; exit 1; fi
  sleep 1
done
HYPER_OFFICE_BATCH_URL=http://127.0.0.1:3123 npm run test:nextcloud -- office-tools.spec.ts
