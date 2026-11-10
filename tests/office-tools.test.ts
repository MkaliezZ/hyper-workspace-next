import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  OfficeOperation,
  OfficeInspection,
  OfficeOperations,
  OfficeProposalApply,
  OfficeProposalCreate,
} from "@hyper/contracts/office";
import {
  OfficeProvider,
  officeDigest,
} from "../apps/api/src/core/office-provider.js";
import { officeCopyName } from "../apps/api/src/core/office.js";

test("Office copy names preserve Unicode code points within source byte limits and retain the proposal UUID", () => {
  const id = randomUUID(),
    name = officeCopyName("😀机密文件".repeat(30) + ".docx", "docx", id);
  assert.ok(Buffer.byteLength(name, "utf8") <= 255);
  assert.ok(name.endsWith("--" + id + ".docx"));
  assert.doesNotThrow(() => encodeURIComponent(name));
  assert.equal(officeCopyName(".xlsx", "xlsx", id), "Office--" + id + ".xlsx");
});

test("Office operations accept only explicit bounded targets and typed cells", () => {
  for (const op of [
    { kind: "writer.append", target: "document:end", text: "Hello" },
    {
      kind: "writer.replace",
      target: "paragraph:999",
      expectedText: "Before",
      text: "After",
    },
    {
      kind: "calc.set",
      sheet: "sheet:15",
      cell: "BL1000",
      expected: { type: "empty", value: null },
      value: { type: "formula", value: "=SUM(A1:A3)" },
    },
    {
      kind: "impress.replace",
      target: "slide:99/shape:999",
      expectedText: "Before",
      text: "After",
    },
  ])
    assert.equal(OfficeOperation.safeParse(op).success, true);
  const append = {
    kind: "writer.append",
    target: "document:end",
    text: "Hello",
  };
  for (const patch of [
    { kind: "script" },
    { target: "/tmp/file" },
    { url: "https://foreign.invalid" },
    { text: "x".repeat(4001) },
    { method: "loadComponentFromURL" },
  ])
    assert.equal(
      OfficeOperation.safeParse({ ...append, ...patch }).success,
      false,
    );
  for (const cell of [
    "BM1",
    "BZ1",
    "A1001",
    "A0",
    "$A$1",
    "A1:B2",
    "../secret",
  ])
    assert.equal(
      OfficeOperation.safeParse({
        kind: "calc.set",
        sheet: "sheet:0",
        cell,
        expected: { type: "empty", value: null },
        value: { type: "number", value: 1 },
      }).success,
      false,
    );
  assert.equal(OfficeOperations.safeParse([append, append]).success, false);
  assert.equal(OfficeOperations.safeParse([]).success, false);
  assert.equal(
    OfficeOperation.safeParse({
      kind: "calc.set",
      sheet: "sheet:0",
      cell: "A1",
      expected: { type: "empty", value: "not null" },
      value: { type: "number", value: Infinity },
    }).success,
    false,
  );
});
test("Office inspection enforces total preview and cell limits across the complete document", () => {
  assert.equal(
    OfficeInspection.safeParse({
      paragraphs: Array.from({ length: 51 }, (_, index) => ({
        id: "paragraph:" + index,
        text: "x".repeat(4000),
        editable: true,
      })),
      appendTarget: "document:end",
    }).success,
    false,
  );
  const sheet = {
    id: "sheet:0",
    name: "Synthetic",
    rows: 1000,
    columns: 2,
    cells: Array.from({ length: 1001 }, () => ({
      address: "A1",
      type: "empty",
      value: null,
      display: "",
      error: 0,
      editable: true,
    })),
  };
  assert.equal(
    OfficeInspection.safeParse({ sheets: [sheet, { ...sheet, id: "sheet:1" }] })
      .success,
    false,
  );
});
test("Office proposal binds source SHA and explicit confirmation and rejects arbitrary destination segments", () => {
  const input = {
    source: { path: ["source.docx"], expectedId: "42", expectedEtag: '"v1"' },
    expectedSha256: "a".repeat(64),
    destination: [],
    operations: [
      { kind: "writer.append", target: "document:end", text: "Proposal" },
    ],
    idempotencyKey: randomUUID(),
  };
  assert.equal(OfficeProposalCreate.safeParse(input).success, true);
  for (const patch of [
    { destination: [".."] },
    { destination: ["a/b"] },
    { expectedSha256: "a" },
    { source: { ...input.source, expectedId: "0" } },
    { outputName: "overwrite.docx" },
  ])
    assert.equal(
      OfficeProposalCreate.safeParse({ ...input, ...patch }).success,
      false,
    );
  const apply = {
    confirmed: true,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  };
  assert.equal(OfficeProposalApply.safeParse(apply).success, true);
  assert.equal(
    OfficeProposalApply.safeParse({ ...apply, confirmed: false }).success,
    false,
  );
  assert.equal(
    OfficeProposalApply.safeParse({ ...apply, expectedRevision: 0 }).success,
    false,
  );
});

const bytes = Buffer.from("Synthetic input"),
  output = Buffer.from("Synthetic output"),
  provider = new OfficeProvider();
let change: (value: any) => any = (value) => value,
  status = 200,
  requests = 0;
const server = createServer(async (req, res) => {
  requests++;
  let body = "";
  for await (const chunk of req) body += chunk;
  assert.equal(req.headers["content-length"], String(Buffer.byteLength(body)));
  const input = JSON.parse(body);
  assert.equal(input.contentBase64, bytes.toString("base64"));
  assert.equal(req.headers.authorization, undefined);
  const base = {
    protocol: "office-batch/v1",
    engine: "collabora-26.04.6.1/pyuno-26.04.6-1",
    sourceSha256: officeDigest(bytes),
    format: "docx",
  };
  const value =
    req.url === "/inspect"
      ? {
          ...base,
          inspection: {
            paragraphs: [
              { id: "paragraph:0", text: "Synthetic input", editable: true },
            ],
            appendTarget: "document:end",
          },
        }
      : {
          ...base,
          contentBase64: output.toString("base64"),
          outputSha256: officeDigest(output),
          summary: {
            operations: [
              {
                kind: "writer.append",
                target: "paragraph:1",
                before: null,
                after: "New paragraph",
              },
            ],
            recalculated: false,
            formulaErrors: [],
            reopenedVerified: true,
          },
        };
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(change(value)));
});
let saved: string | undefined;
before(async () => {
  saved = process.env.HYPER_OFFICE_BATCH_URL;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.HYPER_OFFICE_BATCH_URL =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
after(async () => {
  if (saved === undefined) delete process.env.HYPER_OFFICE_BATCH_URL;
  else process.env.HYPER_OFFICE_BATCH_URL = saved;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
test("Office provider strictly binds input hash, fixed protocol/version, response format and actual binary output", async () => {
  const input = { bytes, format: "docx" as const };
  assert.equal(
    (await provider.inspect(input)).sourceSha256,
    officeDigest(bytes),
  );
  const transform = {
    ...input,
    operations: [
      {
        kind: "writer.append" as const,
        target: "document:end" as const,
        text: "New paragraph",
      },
    ],
  };
  assert.deepEqual((await provider.transform(transform)).bytes, output);
  for (const mutate of [
    (v: any) => ({ ...v, sourceSha256: "0".repeat(64) }),
    (v: any) => ({ ...v, engine: "fake-engine" }),
    (v: any) => ({ ...v, protocol: "office-batch/v2" }),
    (v: any) => ({ ...v, format: "xlsx" }),
    (v: any) => ({ ...v, privateKey: "unexpected" }),
  ]) {
    change = mutate;
    await assert.rejects(() => provider.inspect(input));
    await assert.rejects(() => provider.transform(transform));
  }
  for (const mutate of [
    (v: any) => ({ ...v, outputSha256: "f".repeat(64) }),
    (v: any) => ({ ...v, contentBase64: v.contentBase64 + "!" }),
    (v: any) => ({ ...v, summary: { ...v.summary, reopenedVerified: false } }),
    (v: any) => ({
      ...v,
      summary: {
        ...v.summary,
        operations: [
          {
            kind: "writer.append",
            target: "paragraph:1",
            before: null,
            after: "Forged output",
          },
        ],
      },
    }),
  ]) {
    change = mutate;
    await assert.rejects(() => provider.transform(transform));
  }
  change = (v) => v;
});
test("Office provider rejects operator public endpoints and sanitized remote failures without retrying", async () => {
  const endpoint = process.env.HYPER_OFFICE_BATCH_URL,
    initial = requests;
  for (const url of [
    "https://public.example/",
    "http://127.0.0.1/arbitrary",
    "http://user:pass@127.0.0.1/",
    "http://127.0.0.1/?source=foreign",
  ]) {
    process.env.HYPER_OFFICE_BATCH_URL = url;
    await assert.rejects(() => provider.inspect({ bytes, format: "docx" }));
  }
  process.env.HYPER_OFFICE_BATCH_URL = endpoint;
  assert.equal(requests, initial);
  change = () => ({ error: { code: "sensitive-provider-body-never-return" } });
  for (const code of [400, 409, 413, 422, 503, 504, 500]) {
    status = code;
    await assert.rejects(
      () => provider.inspect({ bytes, format: "docx" }),
      (error) =>
        error instanceof Error && !error.message.includes("sensitive-provider"),
    );
  }
  assert.equal(requests, initial + 7);
  status = 200;
  change = (v) => v;
});
