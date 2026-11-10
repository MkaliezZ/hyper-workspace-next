import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceFileService } from "../../apps/api/src/core/source-files.js";
import { Database } from "../../apps/api/src/db/database.js";
import { createCalendarScope } from "../fixtures/calendar-scope.js";

test("Office link binds to the selected source version and each employee's live file permission", async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.endsWith("_test"));
  const db = new Database(url);
  t.after(() => db.close());
  await db.migrate();
  const f = await createCalendarScope(db);
  t.after(() => f.close());
  const flags = [
    "NEXTCLOUD_FILES_ENABLED",
    "NEXTCLOUD_OFFICE_ENABLED",
  ] as const;
  const before = flags.map((flag) => process.env[flag]);
  t.after(() => {
    flags.forEach((flag, index) => {
      if (before[index] === undefined) delete process.env[flag];
      else process.env[flag] = before[index];
    });
  });
  process.env.NEXTCLOUD_FILES_ENABLED = "true";
  process.env.NEXTCLOUD_OFFICE_ENABLED = "false";
  const file = f.source.files.add(
    "alice",
    ["合成预算.xlsx"],
    Buffer.from("Synthetic source metadata only"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  const selection = {
    path: file.path,
    expectedId: file.id,
    expectedEtag: file.etag,
  };
  const service = new SourceFileService(db);
  await assert.rejects(service.officeLink(f.actor, selection), /尚未启用/);
  process.env.NEXTCLOUD_OFFICE_ENABLED = "true";
  const expectLink = {
    url: process.env.NEXTCLOUD_URL + "/index.php/f/" + file.id,
    checkedEtag: file.etag,
    format: "xlsx",
  };
  assert.deepEqual(await service.officeLink(f.actor, selection), expectLink);
  await assert.rejects(service.officeLink(f.peer, selection), /文件来源拒绝/);
  file.readers.add("bob");
  assert.deepEqual(await service.officeLink(f.peer, selection), expectLink);
  file.blockedDownloads.add("bob");
  await assert.rejects(service.officeLink(f.peer, selection), /文件来源拒绝/);
  await assert.rejects(
    service.officeLink(f.actor, { ...selection, expectedId: "9999" }),
    /所选文件已变化/,
  );
  await assert.rejects(
    service.officeLink(f.actor, { ...selection, expectedEtag: '"stale"' }),
    /所选文件已变化/,
  );
  const txt = f.source.files.add(
    "alice",
    ["notes.txt"],
    Buffer.from("notes"),
    "text/plain",
  );
  await assert.rejects(
    service.officeLink(f.actor, {
      path: txt.path,
      expectedId: txt.id,
      expectedEtag: txt.etag,
    }),
    /支持 DOCX、XLSX 和 PPTX/,
  );
});
