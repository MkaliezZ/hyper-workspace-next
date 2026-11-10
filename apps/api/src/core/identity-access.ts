import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { Vault } from "./credentials.js";
import {
  requireNextcloud,
  NextcloudIdentityProvider,
  type NextcloudConfig,
} from "../providers/nextcloud.js";

/** Revalidate source membership at product boundaries, including the worker before each action. */
export async function verifySourceAccess(db: Database, subject: Subject) {
  const config = requireNextcloud();
  const credential = (
    await db.pool.query(
      "SELECT c.*,i.provider_key,i.remote_uid FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND i.user_id=$2 AND i.workspace_id=$3 AND c.disabled_at IS NULL",
      [subject.identityCredentialId, subject.id, subject.workspaceId],
    )
  ).rows[0];
  if (
    !credential ||
    credential.provider_key !== config.providerKey ||
    subject.workspaceId !== config.workspaceId
  )
    throw new UnauthorizedException("身份来源已更改或凭据已撤销，请重新登录。");
  let remote;
  try {
    remote = await new NextcloudIdentityProvider(config).current({
      loginName: credential.login_name,
      appPassword: new Vault().decrypt(credential.credential_enc),
    });
    if (remote.uid !== credential.remote_uid)
      throw new UnauthorizedException("企业身份发生变化，请重新登录。");
  } catch (error) {
    if (error instanceof UnauthorizedException)
      await db.tx(async (c) => {
        await c.query(
          "UPDATE cw_identity_credentials SET disabled_at=now(),credential_enc='' WHERE id=$1",
          [credential.id],
        );
        await c.query(
          "DELETE FROM cw_sessions WHERE identity_credential_id=$1",
          [credential.id],
        );
      });
    // Outages fail the operation but do not permanently change membership or credentials.
    throw error;
  }
  if (!remote.groups.includes(config.memberGroup)) {
    await revokeMappedMembership(db, config, remote.uid);
    throw new ForbiddenException(
      "企业工作区成员资格已撤销，请联系管理员重新授权。",
    );
  }
  await db.pool.query(
    "UPDATE cw_identity_credentials SET verified_at=now() WHERE id=$1 AND disabled_at IS NULL",
    [credential.id],
  );
  // A concurrent logout/revocation must not be undone by an in-flight source response.
  const live = await db.pool.query(
    "SELECT id FROM cw_identity_credentials WHERE id=$1 AND disabled_at IS NULL",
    [credential.id],
  );
  if (!live.rowCount) throw new UnauthorizedException("此登录凭据已撤销。");
}

/** Used for negative source membership observations from either login or existing sessions. */
export async function revokeMappedMembership(
  db: Database,
  config: NextcloudConfig,
  remoteUid: string,
) {
  await db.tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      config.providerKey + config.workspaceId + remoteUid,
    ]);
    const identity = (
      await c.query(
        "SELECT id,user_id FROM cw_external_identities WHERE provider_key=$1 AND workspace_id=$2 AND remote_uid=$3",
        [config.providerKey, config.workspaceId, remoteUid],
      )
    ).rows[0];
    if (!identity) return;
    await c.query(
      "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
      [config.workspaceId, identity.user_id],
    );
    await c.query(
      `WITH revoked AS (
         UPDATE cw_ocr_documents SET invalidated_at=clock_timestamp()
         WHERE workspace_id=$1 AND actor_id=$2 AND invalidated_at IS NULL RETURNING id
       )
       UPDATE cw_ocr_revisions v SET content=NULL FROM revoked r WHERE v.document_id=r.id`,
      [config.workspaceId, identity.user_id],
    );
    await c.query(
      "DELETE FROM cw_sessions WHERE workspace_id=$1 AND user_id=$2",
      [config.workspaceId, identity.user_id],
    );
    await c.query(
      "UPDATE cw_identity_credentials SET disabled_at=now(),credential_enc='' WHERE identity_id=$1",
      [identity.id],
    );
  });
}
