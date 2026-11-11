#!/usr/bin/env bash
set -euo pipefail
: "${NC_TEST_PASSWORD:?Synthetic CI password required}"

# This script targets the disposable Nextcloud fixture created by nextcloud-setup.sh.
python3 runtime/nextcloud/install-office.py
image="$(python3 -c 'import json; print(json.load(open("runtime/nextcloud/office.lock.json"))["image"])')"
docker cp .runtime/nextcloud/richdocuments hyper-nextcloud-test:/var/www/html/custom_apps/
docker exec --user root hyper-nextcloud-test chown -R www-data:www-data /var/www/html/custom_apps/richdocuments
docker network create hyper-office-ci
docker network connect --alias nextcloud hyper-office-ci hyper-nextcloud-test
docker run --detach --name hyper-collabora-test --network hyper-office-ci --network-alias collabora \
  --cap-add MKNOD \
  --env 'aliasgroup1=http://nextcloud:80' \
  --env 'extra_params=--o:ssl.enable=false --o:ssl.termination=false --o:ssl.ssl_verification=true --o:server_name=127.0.0.1:9980' \
  "$image"
node scripts/office-guard-init.mjs
docker build --file runtime/office-gateway/Dockerfile --tag hyper-office-gateway-ci .
docker run --detach --name hyper-office-gateway-test --network hyper-office-ci --network-alias office-gateway \
  --publish 127.0.0.1:9980:9981 --init --user 10001:10001 --read-only \
  --cap-drop ALL --security-opt no-new-privileges --memory 192m --cpus 0.5 --pids-limit 32 \
  --mount "type=bind,src=$PWD/.runtime/office-guard/secret,dst=/run/secrets/office_guard,readonly" \
  --env HYPER_OFFICE_GATEWAY_BACKEND=http://collabora:9980 \
  --env HYPER_OFFICE_GATEWAY_PUBLIC_ORIGIN=http://127.0.0.1:9980 \
  --env HYPER_OFFICE_GATEWAY_INTERNAL_ORIGIN=http://office-gateway:9981 \
  --env HYPER_OFFICE_GATEWAY_SOURCE_ORIGIN=http://127.0.0.1:8090 \
  --env HYPER_OFFICE_GATEWAY_SOURCE_INTERNAL_ORIGIN=http://nextcloud \
  --env HYPER_OFFICE_GATEWAY_WOPI_ORIGIN=http://nextcloud \
  --env HYPER_OFFICE_GATEWAY_GUARD_SECRET_FILE=/run/secrets/office_guard \
  hyper-office-gateway-ci

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
gateway_ip="$(docker inspect --format '{{(index .NetworkSettings.Networks "hyper-office-ci").IPAddress}}' hyper-office-gateway-test)"
test -n "$office_ip"
test -n "$gateway_ip"
python3 runtime/nextcloud/office-settings.py "$office_ip"
docker cp .runtime/nextcloud/zz-hyper-office-settings.config.php hyper-nextcloud-test:/var/www/html/config/
docker exec --user root hyper-nextcloud-test chmod 644 /var/www/html/config/zz-hyper-office-settings.config.php
docker exec -i hyper-nextcloud-test php /dev/stdin /var/www/html/config/zz-hyper-office-settings.config.php "$office_ip" < tests/fixtures/office-settings.php
occ config:system:set trusted_domains 9 --value=nextcloud
occ config:system:set loglevel --type=integer --value=2
occ app:enable richdocuments
python3 runtime/nextcloud/install-office-guard.py --secret-file .runtime/office-guard/secret \
  --gateway-url http://office-gateway:9982 --gateway-ip "$gateway_ip" \
  --member-group "${NEXTCLOUD_MEMBER_GROUP:?Explicit member group required}"
docker cp .runtime/nextcloud/hyper_office_guard hyper-nextcloud-test:/var/www/html/custom_apps/
docker cp .runtime/nextcloud/zz-hyper-office-guard.config.php hyper-nextcloud-test:/var/www/html/config/
docker exec --user root hyper-nextcloud-test chown -R www-data:www-data /var/www/html/custom_apps/hyper_office_guard
docker exec --user root hyper-nextcloud-test chown www-data:www-data /var/www/html/config/zz-hyper-office-guard.config.php
docker exec --user root hyper-nextcloud-test chmod 640 /var/www/html/config/zz-hyper-office-guard.config.php
docker exec hyper-nextcloud-test find /var/www/html/custom_apps/hyper_office_guard -name '*.php' -exec php -l '{}' ';'
docker exec -i hyper-nextcloud-test php /dev/stdin /var/www/html/custom_apps/hyper_office_guard < tests/fixtures/office-guard.php
occ app:enable hyper_office_guard
for employee in office-alice office-bob; do
  docker exec --user www-data --env OC_PASS="$NC_TEST_PASSWORD" hyper-nextcloud-test php occ user:add --password-from-env "$employee"
  occ group:adduser hyper-members "$employee"
done
occ config:app:set richdocuments wopi_allowlist --value="$office_ip,$gateway_ip"
occ richdocuments:activate-config --wopi-url=http://office-gateway:9981 --callback-url=http://nextcloud
test "$(occ config:app:get richdocuments installed_version)" = 10.3.3
test "$(occ config:app:get richdocuments public_wopi_url)" = http://127.0.0.1:9980
