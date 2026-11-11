#!/usr/bin/env bash
set -euo pipefail
# Real installation overlay on the existing disposable deployment job. Never use a company env.
: "${COMPOSE_TEST_PROJECT:?Disposable deployment project required}"
: "${COMPOSE_TEST_ENV:?Existing disposable deployment environment required}"
node --test scripts/ci/office-installation.test.mjs
node scripts/ci/office-installation.mjs prepare
office_compose() {
  docker compose --project-name "$COMPOSE_TEST_PROJECT" --env-file .runtime/office-installation/compose.env \
    -f compose.yaml -f deploy/compose.ci.yaml -f deploy/compose.local-ocr.yaml \
    -f deploy/compose.office-tools.yaml -f deploy/compose.source.yaml -f deploy/compose.office.yaml \
    -f .runtime/office-installation/loopback.yaml "$@"
}
cleanup() {
  local status=$?
  trap - EXIT
  if ! node scripts/ci/office-installation.mjs cleanup; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
office_compose config --quiet
node scripts/office-guard-init.mjs
python3 runtime/nextcloud/install-office.py
office_compose build office-gateway
printf '%s\n' 'Office installation: starting the dedicated source database initializer'
office_compose up -d --no-deps --no-build source-initialize
node scripts/ci/office-installation.mjs record
initializer="$(office_compose ps -a -q source-initialize)"
test -n "$initializer"
test "$(timeout 90 docker wait "$initializer")" = 0
printf '%s\n' 'Office installation: starting formal Nextcloud, CODE and gateway services'
office_compose up -d --no-deps --no-build --wait --wait-timeout 360 nextcloud collabora office-gateway
node scripts/ci/office-installation.mjs record
source_container="$(office_compose ps -q nextcloud)"
editor_container="$(office_compose ps -q collabora)"
gateway_container="$(office_compose ps -q office-gateway)"
occ() { docker exec --user www-data "$source_container" php occ "$@"; }
occ config:system:set loglevel --type=integer --value=2
docker exec "$source_container" test ! -e /var/www/html/custom_apps/richdocuments
docker cp .runtime/nextcloud/richdocuments "$source_container":/var/www/html/custom_apps/
docker exec --user root "$source_container" chown -R www-data:www-data /var/www/html/custom_apps/richdocuments
occ app:enable richdocuments
occ integrity:check-app richdocuments
test "$(occ config:app:get richdocuments installed_version)" = 10.3.3
editor_ip="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$editor_container")"
gateway_ip="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$gateway_container")"
test -n "$editor_ip"
test -n "$gateway_ip"
occ config:app:set richdocuments wopi_allowlist --value="$editor_ip,$gateway_ip"
python3 runtime/nextcloud/office-settings.py "$editor_ip"
docker cp .runtime/nextcloud/zz-hyper-office-settings.config.php "$source_container":/var/www/html/config/
docker exec --user root "$source_container" chmod 644 /var/www/html/config/zz-hyper-office-settings.config.php
docker exec -i "$source_container" php /dev/stdin /var/www/html/config/zz-hyper-office-settings.config.php "$editor_ip" < tests/fixtures/office-settings.php
node scripts/ci/office-installation.mjs employee
python3 runtime/nextcloud/install-office-guard.py --secret-file .runtime/office-guard/secret \
  --gateway-url http://office-gateway:9982 --gateway-ip "$gateway_ip" --member-group office-install-members
docker cp .runtime/nextcloud/hyper_office_guard "$source_container":/var/www/html/custom_apps/
docker cp .runtime/nextcloud/zz-hyper-office-guard.config.php "$source_container":/var/www/html/config/
docker exec --user root "$source_container" chown -R www-data:www-data /var/www/html/custom_apps/hyper_office_guard
docker exec --user root "$source_container" chown www-data:www-data /var/www/html/config/zz-hyper-office-guard.config.php
docker exec --user root "$source_container" chmod 640 /var/www/html/config/zz-hyper-office-guard.config.php
occ app:enable hyper_office_guard
occ richdocuments:activate-config --wopi-url=http://office-gateway:9981 --callback-url=http://nextcloud
test "$(occ config:app:get richdocuments public_wopi_url)" = http://127.0.0.1:18091
node scripts/ci/office-installation.mjs topology
node --import tsx scripts/ci/office-installation.mjs probe
node scripts/ci/office-installation.mjs preserved
