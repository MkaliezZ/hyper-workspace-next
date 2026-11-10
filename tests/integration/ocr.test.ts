import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Database } from "../../apps/api/src/db/database.js";
import { OcrService } from "../../apps/api/src/core/ocr.js";
import { ocrEndpoint } from "../../apps/api/src/core/ocr-provider.js";
import { createCalendarScope } from "../fixtures/calendar-scope.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Isolated _test database required");
const db = new Database(url);
const service = new OcrService(db);
let identity: Awaited<ReturnType<typeof createCalendarScope>>;
let requests = 0;
let respond: "ok" | "error" | "wrong-bounds" = "ok";
let beforeReply: (() => void) | undefined;
const bytes = Buffer.from(
  "Synthetic OCR image or scan bytes used only in protocol tests.",
);
const engine = createServer(async (req, res) => {
  requests++;
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/recognize");
  assert.ok(
    ["image/png", "application/pdf"].includes(req.headers["content-type"]!),
  );
  assert.ok(["1", "2"].includes(req.headers["x-ocr-page"] as string));
  assert.equal(req.headers.authorization, undefined);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  beforeReply?.();
  res.writeHead(respond === "error" ? 500 : 200, {
    "Content-Type": "application/json",
  });
  res.end(
    JSON.stringify({
      width: 1000,
      height: 1500,
      blocks: [
        {
          kind: "text",
          bounds: [40, 20, respond === "wrong-bounds" ? 1001 : 300, 60],
          confidence: 0.68,
          text: "合成测试",
        },
        {
          kind: "table",
          bounds: [50, 70, 700, 300],
          confidence: null,
          text: "Item\tQty\nPen\t3",
        },
      ],
    }),
  );
});

before(async () => {
  await db.migrate();
  identity = await createCalendarScope(db);
  process.env.NEXTCLOUD_FILES_ENABLED = "true";
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  process.env.HYPER_OCR_URL =
    "http://127.0.0.1:" +
    (engine.address() as { port: number }).port +
    "/recognize";
  process.env.HYPER_OCR_ENGINE = "synthetic-contract/v1";
});
after(async () => {
  engine.closeAllConnections();
  await new Promise<void>((resolve) => engine.close(() => resolve()));
  await identity?.close();
  await db.close();
});

test("Selected OCR pages are private, versioned and explicitly confirmed without changing coordinates", async () => {
  const { actor, peer, source } = identity;
  const file = source.files.add("alice", ["synthetic.png"], bytes, "image/png");
  file.readers.add("bob");
  const selection = {
    path: file.path,
    expectedId: file.id,
    expectedEtag: file.etag,
    page: 1,
  };
  assert.equal(await service.lookup(actor, selection), null);
  const request = {
    source: selection,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  };
  const draft = await service.recognize(actor, request);
  assert.equal(draft.state, "draft");
  assert.equal(draft.revision, 1);
  assert.equal(draft.confirmedRevision, null);
  const calls = requests;
  assert.deepEqual(await service.recognize(actor, request), draft);
  assert.equal(requests, calls);
  await assert.rejects(service.detail(peer, draft.id), /不存在|失效/);
  assert.equal(await service.lookup(peer, selection), null);
  await assert.rejects(
    service.recognize(actor, { ...request, idempotencyKey: randomUUID() }),
    /版本已更新/,
  );
  await assert.rejects(
    service.recognize(actor, { ...request, source: { ...selection, page: 2 } }),
    /只有第 1 页/,
  );
  const payload = {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    texts: ["已校对", "Item\tQty\nPen\t3"],
  };
  const [first, second] = await Promise.all([
    service.confirm(actor, draft.id, payload),
    service.confirm(actor, draft.id, payload),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.state, "confirmed");
  assert.equal(first.confirmedRevision, 2);
  assert.equal(first.content.blocks[0]!.text, "已校对");
  assert.deepEqual(
    first.content.blocks[0]!.bounds,
    draft.content.blocks[0]!.bounds,
  );
  await assert.rejects(
    service.confirm(actor, draft.id, { ...payload, texts: ["不同", "不同"] }),
    /不能更换/,
  );
  respond = "error";
  try {
    await assert.rejects(
      service.recognize(actor, {
        ...request,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
      }),
      /已保存版本/,
    );
    assert.deepEqual(await service.detail(actor, draft.id), first);
  } finally {
    respond = "ok";
  }
  const newer = await service.recognize(actor, {
    ...request,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  assert.equal(newer.revision, 3);
  assert.equal(newer.confirmedRevision, 2);
  assert.equal(
    (await service.detail(actor, draft.id, 2)).content.blocks[0]!.text,
    "已校对",
  );
  file.blockedDownloads.add("alice");
  await assert.rejects(service.detail(actor, draft.id), /旧识别内容已清理/);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(content)::int AS count FROM cw_ocr_revisions WHERE document_id=$1",
        [draft.id],
      )
    ).rows[0].count,
    0,
  );
});

test("OCR selects one PDF page and drops stale or malformed engine output", async () => {
  const { actor, source } = identity;
  const file = source.files.add(
    "alice",
    ["synthetic.pdf"],
    bytes,
    "application/pdf",
  );
  const request = {
    source: {
      path: file.path,
      expectedId: file.id,
      expectedEtag: file.etag,
      page: 2,
    },
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  };
  assert.throws(() => ocrEndpoint("https://free-oxr.somark.ai/api/v1"), /内网/);
  respond = "wrong-bounds";
  try {
    await assert.rejects(service.recognize(actor, request), /未返回可用结果/);
  } finally {
    respond = "ok";
  }
  beforeReply = () => {
    file.etag = '"v2"';
  };
  try {
    await assert.rejects(
      service.recognize(actor, request),
      /来源文件或版本已变化/,
    );
  } finally {
    beforeReply = undefined;
  }
  const current = { ...request.source, expectedEtag: file.etag };
  assert.equal(await service.lookup(actor, current), null);
  const page2 = await service.recognize(actor, { ...request, source: current });
  const page1 = await service.recognize(actor, {
    ...request,
    source: { ...current, page: 1 },
    idempotencyKey: randomUUID(),
  });
  assert.notEqual(page1.id, page2.id);
  file.etag = '"v3"';
  await assert.rejects(service.detail(actor, page1.id), /旧识别内容已清理/);
  await assert.rejects(service.detail(actor, page2.id), /来源已失效/);
});

test("Revoking Nextcloud workspace membership clears all saved OCR text for that employee", async () => {
  const { actor, source } = identity;
  const file = source.files.add("alice", ["revoke.png"], bytes, "image/png");
  const saved = await service.recognize(actor, {
    source: {
      path: file.path,
      expectedId: file.id,
      expectedEtag: file.etag,
      page: 1,
    },
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  source.people.get("alice")!.member = false;
  await assert.rejects(service.detail(actor, saved.id), /已撤销/);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(content)::int AS count FROM cw_ocr_revisions WHERE document_id=$1",
        [saved.id],
      )
    ).rows[0].count,
    0,
  );
});
