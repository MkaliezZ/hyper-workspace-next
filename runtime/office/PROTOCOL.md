# Office batch protocol v1

Private HTTP JSON service, port 3123. No authentication or product credentials:
only API/Worker join its dedicated internal Compose network. Product services
must authorize the current actor, recheck source ID/ETag and permissions, bind an
approved proposal, and upload the returned **new copy** to Nextcloud themselves.
This runtime never fetches URLs, writes Nextcloud, or overwrites an original.

`GET /health` returns `{ "status": "ok", "protocol": "office-batch/v1",
"engine": "collabora-26.04.6.1/pyuno-26.04.6-1" }`.

`POST /inspect` accepts exactly `{ "format": "docx"|"xlsx"|"pptx",
"contentBase64": "..." }`. `POST /transform` also requires `sourceSha256`
(the exact lowercase SHA256 returned by inspect) and `operations` (1–32).
Unknown keys, malformed base64, macro-enabled/encrypted/unsupported packages,
excessive ZIP expansion, new hyperlinks and unsupported targets are rejected.
XML package parts must use UTF-8; other encodings are explicitly unsupported.
Content-Type must be application/json; Content-Length is mandatory; chunked
requests are rejected. Requests are not persisted or logged.

Successful inspect returns `{protocol, engine, format, sourceSha256, inspection}`.
Inspection is complete within the bounds below; it never silently truncates.
Target IDs are stable for the **same exact input bytes only**, not across saves.

- DOCX: `{ paragraphs: [{id:"paragraph:0",text,editable}], appendTarget:"document:end" }`.
  IDs enumerate top-level body paragraphs, excluding table cells. Complex fields,
  inline objects and existing hyperlinks make a paragraph noneditable. Header,
  footer, table and nested text targets are not supported in v1.
- XLSX: `{ sheets: [{id:"sheet:0",name,rows,columns,cells:[{address,type,value,display,error,editable}]}] }`.
  Used rectangular cells are returned, including empty cells. `type` is `empty`,
  `string`, `number` or `formula`; `value` is respectively null, text, number or
  the engine's canonical formula. `display` is formatted text; `error` is the
  Calc error code (0 = none). Only unmerged, unprotected cells are editable.
  A supported pivot's output, source header and grouping-key cells are also
  noneditable. Its numeric source values may be edited with ordinary calc.set.
- PPTX: `{ slides: [{id:"slide:0",shapes:[{id:"slide:0/shape:1",text,editable}]}] }`.
  All top-level shapes are identified; only simple text shapes are editable.
  Tables, groups, fields and inherited master shapes are not text targets.
  Non-text shapes have `text:""` and `editable:false`.

Fixed operations (exact keys, no UNO methods, scripts, filenames or URLs):

```json
{"kind":"writer.append","target":"document:end","text":"New paragraph"}
{"kind":"writer.replace","target":"paragraph:2","expectedText":"Editable text","text":"New text"}
{"kind":"calc.set","sheet":"sheet:1","cell":"B5","expected":{"type":"string","value":"Editable text"},"value":{"type":"string","value":"New text"}}
{"kind":"impress.replace","target":"slide:0/shape:1","expectedText":"Editable text","text":"New text"}
```

`calc.set.value` supports `empty/null`, `string`, finite `number`, or `formula`.
To clear a cell use `empty/null`; an empty `string` value is rejected explicitly.
New formulas use a deliberately small grammar: `=`, numeric constants, A1 cells
and ranges, `Sheet!A1` / `'Sheet Name'!A1`, and the engine's equivalent canonical
`Sheet.A1` / `$'Sheet Name'.$A$1` references; arithmetic `+ - * / ^`, parentheses,
and SUM/MIN/MAX/AVERAGE/COUNT with comma or canonical semicolon arguments. Quoted
sheet names support doubled apostrophes. References must resolve to
existing sheets and bounded cells. No named ranges, external workbooks, URLs,
strings, DDE, WEBSERVICE, HYPERLINK, INDIRECT or arbitrary functions. Returned
formulas use Calc's canonical spelling; use inspect values verbatim for expected.
Repeated targets in a proposal are rejected. Expected values refer to the source,
not to earlier operations. Text replacement is explicit plain text and can replace
inline run formatting in the selected paragraph/shape; surrounding objects remain
subject to the same-core roundtrip limits, not a blanket fidelity guarantee.
Text operations accept a single paragraph (no newline/control characters; tab is allowed).

Successful transform returns `{protocol,engine,format,sourceSha256,contentBase64,
outputSha256,summary:{operations:[{kind,target,before,after}],recalculated:boolean,
formulaErrors:[{sheet,cell,error}],reopenedVerified:true}}`.
The service saves to a new file, reopens with the same engine, and verifies every
operation's resulting content. Calc always calls calculateAll, and reports every
remaining formula error in the bounded workbook; errors in a newly assigned
formula reject the transform. Output is editable OOXML, not an image/PDF.

The pivot subset is deliberately narrow: one pivot in the workbook, one bounded
local worksheet source on a different sheet, one text row field and one numeric
SUM field. Source headers must be unique, and source records may contain only
constant strings/numbers/empty cells. External/named sources, formulas inside the
pivot source, calculated/grouped fields, filters, custom field/item captions,
column/page fields, multiple aggregations and explicit `grandTotalCaption` are
unsupported. The engine's default total label is `Total Result`; absent an
explicit caption, default presentation may be normalized to that label.
An explicit caption is rejected with `unsupported_pivot_caption`, because this
pinned engine does not preserve it. Other unsupported cases return
`unsupported_pivot_source/layout/aggregation/value/target/cache` as appropriate.
The runtime explicitly refreshes the supported local pivot after source edits,
checks every grouped sum and grand total against the source, verifies the saved
cache records, and compares the pivot definition and values after a same-core
reopen. It never patches OOXML or accepts a changed explicit label as success.
See [compatibility evidence](COMPATIBILITY.md) for the observed engine limitation.

Errors are `{error:{code:"..."}}`, with no raw engine error/input/URL. HTTP 400
invalid JSON/headers, 413 input/package/output limit, 422 unsupported/invalid
operation/target/formula or calculation error, 409 source/expected mismatch,
503 busy (Retry-After: 1), 504 engine timeout, 500 sanitized engine failure.
No durable jobs or automatic retry: callers own idempotency and write recovery.

Limits: input/output 8 MiB each; JSON 12 MiB; ZIP 2048 entries, 64 MiB expanded,
16 MiB per entry, 200:1 expansion; 32 operations; 4000 characters per text;
200000 preview characters; 1000 body paragraphs; 16 sheets, 1000 rows/64 columns,
2000 used cells total; 100 slides/1000 shapes total; 60 seconds per engine job.
No request queue: one active request; busy work is rejected before reading its
body. Slow input times out after 10 seconds. Profiles and intermediate files are
request-local and removed on success/failure/timeout. A process-group kill covers
both UNO client and soffice. Non-AF_UNIX sockets are forbidden by seccomp in the
worker and all descendants; UNO uses a private named pipe. Service health only
checks protocol readiness; real-kernel tests establish document capability.
The 10-second body deadline is total elapsed time, not reset by arriving bytes.
io_uring setup/enter/register are also forbidden to close alternate socket creation.
