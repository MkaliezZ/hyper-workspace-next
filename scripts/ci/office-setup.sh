#!/usr/bin/env bash
set -euo pipefail

# This script targets the disposable Nextcloud fixture created by nextcloud-setup.sh.
python3 runtime/nextcloud/install-office.py
image="$(python3 -c 'import json; print(json.load(open("runtime/nextcloud/office.lock.json"))["image"])')"
docker cp .runtime/nextcloud/richdocuments hyper-nextcloud-test:/var/www/html/custom_apps/
docker exec --user root hyper-nextcloud-test chown -R www-data:www-data /var/www/html/custom_apps/richdocuments
docker network create hyper-office-ci
docker network connect --alias nextcloud hyper-office-ci hyper-nextcloud-test
docker run --detach --name hyper-collabora-test --network hyper-office-ci --network-alias collabora \
  --publish 127.0.0.1:9980:9980 --cap-add MKNOD \
  --env 'aliasgroup1=http://nextcloud:80' \
  --env 'extra_params=--o:ssl.enable=false --o:ssl.termination=false --o:ssl.ssl_verification=true --o:server_name=127.0.0.1:9980' \
  "$image"

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
python3 runtime/nextcloud/office-settings.py "$office_ip"
docker cp .runtime/nextcloud/zz-hyper-office-settings.config.php hyper-nextcloud-test:/var/www/html/config/
docker exec --user root hyper-nextcloud-test chmod 644 /var/www/html/config/zz-hyper-office-settings.config.php
docker exec -i hyper-nextcloud-test php /dev/stdin /var/www/html/config/zz-hyper-office-settings.config.php "$office_ip" < tests/fixtures/office-settings.php
occ config:system:set trusted_domains 9 --value=nextcloud
occ app:enable richdocuments
occ config:app:set richdocuments wopi_allowlist --value="$office_ip"
occ richdocuments:activate-config --wopi-url=http://collabora:9980 --callback-url=http://nextcloud
test "$(occ config:app:get richdocuments installed_version)" = 10.3.3
test "$(occ config:app:get richdocuments public_wopi_url)" = http://127.0.0.1:9980
