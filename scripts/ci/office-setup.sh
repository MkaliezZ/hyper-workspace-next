#!/usr/bin/env bash
set -euo pipefail

# This script targets the disposable Nextcloud fixture created by nextcloud-setup.sh.
archive=.runtime/nextcloud/richdocuments-v10.3.3.tar.gz
mkdir -p .runtime/nextcloud
curl --connect-timeout 20 --max-time 180 --retry 2 --fail --silent --show-error --location \
  https://github.com/nextcloud-releases/richdocuments/releases/download/v10.3.3/richdocuments-v10.3.3.tar.gz \
  --output "$archive"
printf '%s  %s\n' 82a9e4c6fda4fd32a44587827cf9f68babbad370517b8a7a5f413e4f3c642528 "$archive" | sha256sum --check
python3 - "$archive" <<'PY'
import sys
import tarfile
import xml.etree.ElementTree as ET
with tarfile.open(sys.argv[1]) as archive:
    manifest = ET.fromstring(archive.extractfile("richdocuments/appinfo/info.xml").read())
    assert manifest.findtext("version") == "10.3.3"
    dependency = manifest.find("dependencies/nextcloud")
    assert dependency.attrib == {"min-version": "33", "max-version": "33"}
    archive.extractall(".runtime/nextcloud", filter="data")
PY
docker cp .runtime/nextcloud/richdocuments hyper-nextcloud-test:/var/www/html/custom_apps/
docker exec --user root hyper-nextcloud-test chown -R www-data:www-data /var/www/html/custom_apps/richdocuments
docker network create hyper-office-ci
docker network connect --alias nextcloud hyper-office-ci hyper-nextcloud-test
docker run --detach --name hyper-collabora-test --network hyper-office-ci --network-alias collabora \
  --publish 127.0.0.1:9980:9980 --cap-add MKNOD \
  --env 'aliasgroup1=http://nextcloud:80' \
  --env 'extra_params=--o:ssl.enable=false --o:ssl.termination=false --o:server_name=127.0.0.1:9980' \
  collabora/code:26.04.6.1.1@sha256:95f29f1c0a1778999125f53f058d968fe0afb37c95e32ebfb9f3444140faebd2

for attempt in $(seq 1 60); do
  if curl --max-time 3 --silent --fail http://127.0.0.1:9980/hosting/discovery > .runtime/nextcloud/collabora-discovery.xml; then
    break
  fi
  if [ "$attempt" = 60 ]; then
    docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' hyper-collabora-test
    exit 1
  fi
  sleep 2
done
python3 - <<'PY'
from xml.etree.ElementTree import parse
actions = parse(".runtime/nextcloud/collabora-discovery.xml").findall(".//action")
editable = {action.get("ext") for action in actions if action.get("name") == "edit"}
assert {"docx", "xlsx", "pptx"} <= editable
PY
occ() { docker exec --user www-data hyper-nextcloud-test php occ "$@"; }
office_ip="$(docker inspect --format '{{(index .NetworkSettings.Networks "hyper-office-ci").IPAddress}}' hyper-collabora-test)"
test -n "$office_ip"
occ config:system:set trusted_domains 9 --value=nextcloud
occ app:enable richdocuments
occ config:app:set richdocuments wopi_allowlist --value="$office_ip"
occ richdocuments:activate-config --wopi-url=http://collabora:9980 --callback-url=http://nextcloud
test "$(occ config:app:get richdocuments installed_version)" = 10.3.3
test "$(occ config:app:get richdocuments public_wopi_url)" = http://127.0.0.1:9980
