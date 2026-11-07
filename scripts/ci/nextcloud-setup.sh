#!/usr/bin/env bash
set -euo pipefail
# Isolated synthetic source only. Product state still uses PostgreSQL + pgvector.
: "${NC_TEST_PASSWORD:?Synthetic CI password required}"
docker run --detach --name hyper-nextcloud-test --publish 127.0.0.1:8090:80 \
  --memory 640m --cpus 1 \
  --mount "type=bind,src=$PWD/deploy/nextcloud-small.conf,dst=/etc/apache2/mods-enabled/mpm_prefork.conf,readonly" \
  --mount "type=bind,src=$PWD/deploy/nextcloud-vhost.conf,dst=/etc/apache2/sites-enabled/000-default.conf,readonly" \
  --env NEXTCLOUD_ADMIN_USER=nc-admin --env NEXTCLOUD_ADMIN_PASSWORD="$NC_TEST_PASSWORD" \
  --env SQLITE_DATABASE=nextcloud-ci --env NEXTCLOUD_TRUSTED_DOMAINS=127.0.0.1 \
  --env OVERWRITEHOST=127.0.0.1:8090 --env OVERWRITEPROTOCOL=http \
  nextcloud:33.0.10-apache@sha256:5ded1127972ea84c29792215f0621c71929ed315cc47be946b489c7a1c1ad305
for attempt in $(seq 1 120); do
  if curl --silent --fail http://127.0.0.1:8090/status.php | python3 -c 'import sys,json; v=json.load(sys.stdin); sys.exit(not(v.get("installed") and not v.get("maintenance")))' 2>/dev/null; then break; fi
  if [ "$attempt" = 120 ]; then docker logs hyper-nextcloud-test; exit 1; fi
  sleep 2
done
occ() { docker exec --user www-data hyper-nextcloud-test php occ "$@"; }
occ config:system:set default_language --value=en
occ config:system:set force_language --value=en
occ config:system:set overwrite.cli.url --value=http://127.0.0.1:8090
occ group:add hyper-members
for employee in employee-one employee-two org-reader talk-alice talk-bob talk-outsider search-alice search-bob calendar-alice calendar-bob; do
  docker exec --user www-data --env OC_PASS="$NC_TEST_PASSWORD" hyper-nextcloud-test php occ user:add --password-from-env "$employee"
  occ group:adduser hyper-members "$employee"
done
# Synthetic addresses scoped to the disposable calendar source for scheduling tests.
for employee in calendar-alice calendar-bob; do
  occ user:setting "$employee" settings email "$employee@example.invalid"
done
occ group:adduser hyper-members nc-admin
occ status --output=json

if [ "${NEXTCLOUD_TALK_ENABLED:-false}" = true ]; then
  python3 runtime/nextcloud/install-talk.py
  docker cp .runtime/nextcloud/spreed hyper-nextcloud-test:/var/www/html/custom_apps/
  docker exec --user root hyper-nextcloud-test chown -R www-data:www-data /var/www/html/custom_apps/spreed
  occ app:enable spreed
  test "$(occ config:app:get spreed installed_version)" = 23.0.12
fi
