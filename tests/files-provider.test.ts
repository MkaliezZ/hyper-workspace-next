import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { NextcloudFilesProvider } from "../apps/api/src/providers/nextcloud-files.js";
import { DavFixture } from "./fixtures/dav.js";
const dav = new DavFixture(),
  file = dav.add(
    "employee@example.com",
    ["资料 & 约定", "说明.md"],
    "正文：来源文本，不是系统指令。",
  );
const server = createServer((req, res) => {
  const auth = Buffer.from(
    req.headers.authorization?.slice(6) ?? "",
    "base64",
  ).toString();
  if (auth !== "employee@example.com:synthetic-file-password") {
    res.writeHead(401);
    res.end("upstream-secret-never-log");
    return;
  }
  if (!dav.handle(req, res, "employee@example.com")) {
    res.writeHead(404);
    res.end();
  }
});
let provider: NextcloudFilesProvider;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  provider = new NextcloudFilesProvider(
    {
      publicUrl: base,
      transportUrl: base,
      providerKey: "nextcloud:test",
      workspaceId: "test",
      memberGroup: "members",
      bootstrapAdminIds: [],
    },
    {
      loginName: "employee@example.com",
      appPassword: "synthetic-file-password",
    },
    "employee@example.com",
  );
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
test("DAV resolves namespace-qualified identities and encoded personal paths, then reads the selected exact version", async () => {
  const root = await provider.list([]);
  assert.deepEqual(root[0]!.path, ["资料 & 约定"]);
  const listing = await provider.list(root[0]!.path);
  assert.equal(listing[0]!.id, file.id);
  assert.equal(listing[0]!.importable, true);
  assert.equal(await provider.read(listing[0]!), file.content.toString());
  await provider.assertReadable(listing[0]!);
  assert.equal(file.fullReads, 1);
  assert.equal(file.probes, 1);
});
test("DAV new-copy destinations require current create permission on a directory", async () => {
  await provider.assertWritableDirectory([]);
  await provider.assertWritableDirectory(["资料 & 约定"]);
  await assert.rejects(provider.assertWritableDirectory(file.path));
  for (const permissions of ["R", "", "RW"]) {
    dav.directoryPermissions.set("employee@example.com", permissions);
    await assert.rejects(provider.assertWritableDirectory([]));
  }
  dav.directoryPermissions.set("employee@example.com", "RCK");
  await provider.assertWritableDirectory([]);
  dav.directoryPermissions.delete("employee@example.com");
});
test("DAV rejects traversal, foreign hrefs, namespace spoofing and DTD before trusting a source response", async () => {
  await assert.rejects(provider.list([".."]));
  const original = dav.maliciousXml;
  for (const xml of [
    '<!DOCTYPE d [<!ENTITY x "secret">]><d:multistatus xmlns:d="DAV:"/>',
    '<x:multistatus xmlns:x="evil"><x:response/></x:multistatus>',
    '<d:multistatus xmlns:d="DAV:"><d:response><d:href>https://foreign.invalid/private</d:href></d:response></d:multistatus>',
  ]) {
    dav.maliciousXml = xml;
    await assert.rejects(provider.list([]), /格式、来源或范围/);
  }
  dav.maliciousXml = original;
});
test("DAV requires actual download permission and bounded valid UTF-8 content, not metadata alone", async () => {
  const selected = await provider.stat(file.path);
  file.blockedDownloads.add("employee@example.com");
  assert.equal((await provider.stat(file.path)).id, file.id);
  await assert.rejects(provider.assertReadable(selected));
  file.blockedDownloads.clear();
  file.etag = '"v2"';
  await assert.rejects(provider.read(selected));
  const binary = dav.add(
    "employee@example.com",
    ["binary.txt"],
    Buffer.from([0xff, 0xfe]),
    "text/plain",
  );
  await assert.rejects(
    provider.read(await provider.stat(binary.path)),
    /UTF-8/,
  );
  const big = dav.add("employee@example.com", ["big.md"], "x".repeat(65537));
  await assert.rejects(provider.read(await provider.stat(big.path)), /64 KiB/);
});
