#!/usr/bin/env bash
set -euo pipefail
# Run from repository root on Linux amd64; fixtures need the documents test venv.
python3 tests/office/test_protocol.py -v
mkdir -p .runtime
task_dir="$(mktemp -d "${PWD}/.runtime/office-batch-XXXXXX")"
container="hyper-office-batch-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
mkdir -p "$task_dir/input" "$task_dir/output"
chmod 755 "$task_dir" "$task_dir/input"
chmod 777 "$task_dir/output"
fixture_python="${DOCUMENTS_PYTHON:-.runtime/documents/bin/python}"
for kind in docx xlsx pptx; do
  "$fixture_python" tests/fixtures/office-roundtrip.py create "$kind" > "$task_dir/input/roundtrip-seed.$kind"
done
docker build --memory=512m -t hyper-workspace-office-batch:test -f runtime/office/Dockerfile .
docker run -d --name "$container" --init --network=none --memory=512m --memory-swap=512m --cpus=1 \
  --pids-limit=128 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=1770 \
  --mount "type=bind,src=$task_dir/input,dst=/input,readonly" \
  --mount "type=bind,src=$task_dir/output,dst=/output" \
  --mount "type=bind,src=$PWD/tests/office,dst=/tests,readonly" \
  hyper-workspace-office-batch:test >/dev/null
docker exec "$container" /opt/collaboraoffice/program/python.bin /tests/runtime_probe.py /input /output
for kind in docx xlsx pptx; do
  "$fixture_python" tests/fixtures/office-roundtrip.py verify "$kind" "$task_dir/output/edited.$kind" "Hyper Office batch verified"
done
if [ "$(docker inspect --format '{{.State.OOMKilled}}' "$container")" != false ]; then
  echo 'Office batch test exhausted its memory limit' >&2
  exit 1
fi
echo 'Real Office batch roundtrip and cleanup passed; synthetic outputs:' "$task_dir/output"
