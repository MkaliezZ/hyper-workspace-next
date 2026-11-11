# Hyper Office Guard

This companion app is owned by Hyper Workspace and uses the repository's MIT license. Nextcloud 33.0.10 and signed richdocuments 10.3.3 keep their upstream licenses and code. This app depends on the pinned richdocuments token mapper and user-scope service; their contracts must be reviewed when upgrading.

The private `POST /index.php/apps/hyper_office_guard/check` route accepts only the configured gateway's direct peer IP and `X-Hyper-Office-Guard-Secret`. It never trusts forwarded client addresses. Its `{fileId,token}` request resolves a nonexpired, named local-user WOPI token, matching instance/file/version, an existing enabled account, the configured workspace member group, and the current user's effective file READ/UPDATE permissions. The response is `{fileId,userId,canRead,canWrite}`. Missing read access is denied; old token write permission cannot override a current downgrade. Guest, public-link and remote-user tokens are not supported by this workspace-specific CODE entry point.

Global AppFramework middleware targets only the source's `ShareAPIController.deleteShare` and `updateShare`. It pauses the gateway before those controllers run. Failure prevents entry into the controller; both success and exception paths revalidate before releasing the hold. An unconfirmed post-change release returns HTTP 503 and directs the caller to check actual share state. Source OCS and Web UI changes use this path. Source post-share, group-removal/deletion and user-deletion listeners also invalidate sessions. Background/CLI changes and lost notifications are additionally covered by the gateway's bounded permission lease; this is not a claim of cross-system atomicity or zero delay.

The installer stages this app and a private system configuration fragment:

```sh
python3 runtime/nextcloud/install-office-guard.py \
  --secret-file .runtime/office-guard/secret \
  --gateway-url http://office-gateway:9982 \
  --gateway-ip GATEWAY_CONTAINER_IP \
  --member-group "$NEXTCLOUD_MEMBER_GROUP"
```

It writes `.runtime/nextcloud/hyper_office_guard` and `.runtime/nextcloud/zz-hyper-office-guard.config.php` without printing private configuration. Install the app under `custom_apps`, and make its config readable only by the source server account (0640). CODE must have no published bypass port. Use the repository's deployment/CI wiring for gateway startup, WOPI allowlisting and readiness. Keep Nextcloud's log level at warning (`2`) or higher: the pinned upstream token mapper contains a debug-level token-record log.

`tests/fixtures/office-guard.php` covers policy and middleware boundaries using interface doubles. PHP lint and class loading against the real pinned Nextcloud are separate checks; these checks do not prove browser isolation. Actual multi-user editing, permissions loss, copy recovery and source readback must be recorded by the Nextcloud browser suite.
