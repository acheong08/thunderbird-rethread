"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const C = require("../src/rethread-core.js");

const msg = (headers, body = "Hello\r\n", eol = "\r\n") =>
  headers.join(eol) + eol + eol + body.replace(/\r?\n/g, eol);

const orphan = msg([
  "From: rsync.net Customer Support <support@rsync.net>",
  "To: me@duti.dev",
  "Subject: Your rsync.net filesystem is ready!",
  "Date: Tue, 24 Nov 2026 13:04:00 +0000",
  "Message-ID: <ticket-1@rsync.net>",
  "X-Mozilla-Status: 0001",
  "X-Mozilla-Status2: 00000000",
  "Content-Type: text/plain; charset=ISO-8859-1",
  "Content-Transfer-Encoding: 8bit",
], "Gr\xfc\xdfe aus Z\xfcrich\r\n\r\nBody line 2\r\n");

test("rewrite points the message at the root and keeps the body byte-for-byte", () => {
  const out = C.rewriteIntoThread(orphan, {
    rootId: "<root@me>",
    rootReferences: ["<older@me>"],
    date: "2026-11-25T00:00:00.000Z",
  });
  const info = C.readThreadInfo(out);
  assert.equal(info.messageId, "<ticket-1@rsync.net>", "own Message-ID kept");
  assert.deepEqual(info.references, ["<older@me>", "<root@me>"], "root is last");
  assert.deepEqual(info.inReplyTo, ["<root@me>"]);
  assert.ok(info.rethreaded);
  assert.ok(out.endsWith("\r\n\r\nGr\xfc\xdfe aus Z\xfcrich\r\n\r\nBody line 2\r\n"));
  assert.ok(!/X-Mozilla-Status/i.test(out), "mbox bookkeeping dropped");
  assert.ok(!/(^|[^\r])\n/.test(out), "CRLF preserved everywhere");
});

test("undo restores the exact original References/In-Reply-To", () => {
  const original = msg([
    "From: a@b",
    "Subject: Re: Zurich location availability?",
    "Message-ID: <r2@rsync.net>",
    "In-Reply-To: <q1@duti.dev>",
    "References: <q0@duti.dev>\r\n\t<q1@duti.dev>",
  ]);
  const once = C.rewriteIntoThread(original, { rootId: "<root@me>" });
  // Merging a second time must not overwrite the stash with rewritten values.
  const twice = C.rewriteIntoThread(once, { rootId: "<other-root@me>" });
  assert.deepEqual(C.readThreadInfo(twice).references.slice(-1), ["<other-root@me>"]);
  const back = C.restoreOriginal(twice);
  const info = C.readThreadInfo(back);
  assert.deepEqual(info.references, ["<q0@duti.dev>", "<q1@duti.dev>"]);
  assert.deepEqual(info.inReplyTo, ["<q1@duti.dev>"]);
  assert.ok(!info.rethreaded);
  assert.ok(back.includes("References: <q0@duti.dev>\r\n\t<q1@duti.dev>"), "original folding kept");
  assert.equal(C.restoreOriginal(original), null);
});

test("undo of a message that had no threading headers removes them again", () => {
  const back = C.restoreOriginal(C.rewriteIntoThread(orphan, { rootId: "<root@me>" }));
  const info = C.readThreadInfo(back);
  assert.deepEqual(info.references, []);
  assert.deepEqual(info.inReplyTo, []);
});

test("LF-only messages, mbox envelope, long reference chains", () => {
  const refs = Array.from({ length: 60 }, (_, i) => `<chain-${i}@example.com>`).join(" ");
  const raw = "From - Tue Nov 24 13:04:00 2026\n" + msg([
    "From: x@y", "Subject: s", "Message-ID: <me@x>", "References: " + refs,
  ], "body\n", "\n");
  const out = C.rewriteIntoThread(raw, { rootId: "<root@me>" });
  assert.ok(!out.includes("\r"), "LF kept");
  assert.ok(!out.startsWith("From -"), "envelope dropped");
  assert.ok(out.split("\n").every((l) => l.length <= 998));
  const info = C.readThreadInfo(out);
  assert.equal(info.references.length, 41);
  assert.equal(info.references[0], "<chain-0@example.com>");
  assert.equal(info.references.at(-1), "<root@me>");
});

test("never makes a message reference itself", () => {
  const out = C.rewriteIntoThread(orphan, {
    rootId: "<root@me>",
    rootReferences: ["<ticket-1@rsync.net>"],
  });
  assert.ok(!C.readThreadInfo(out).references.includes("<ticket-1@rsync.net>"));
});

test("message without Message-ID gets one; header-only message stays valid", () => {
  const raw = "From: x@y\r\nSubject: none\r\n";
  const out = C.rewriteIntoThread(raw, { rootId: "<root@me>", addMessageId: "<new@id>" });
  assert.equal(C.readThreadInfo(out).messageId, "<new@id>");
  assert.ok(out.endsWith("\r\n\r\n"));
  assert.equal(C.readThreadInfo(C.addMessageId(raw, "<n@x>")).messageId, "<n@x>");
  assert.equal(C.addMessageId(orphan, "<n@x>"), null);
});

test("base64 round trip covers all byte values", () => {
  let s = "";
  for (let i = 0; i < 256; i++) s += String.fromCharCode(i);
  for (const cut of [0, 1, 2, 255, 256]) assert.equal(C.fromBase64(C.toBase64(s.slice(0, cut))), s.slice(0, cut));
});

test("planMerge: existing thread wins, orphans get rewritten oldest-first", () => {
  const it = (key, messageId, references, date) => ({ key, messageId, references, inReplyTo: [], date });
  const plan = C.planMerge([
    it("old-orphan", "<o0@x>", [], 1), // older than the thread, but alone
    it("t1", "<t1@x>", [], 10),
    it("t2", "<t2@x>", ["<t1@x>"], 11),
    it("t3", "<t3@x>", ["<t1@x>", "<t2@x>"], 12),
    it("orphan-b", "<b@x>", [], 30),
    it("orphan-a", "<a@x>", [], 20),
  ]);
  assert.equal(plan.root.key, "t1");
  assert.deepEqual(plan.target.map((x) => x.key), ["t1", "t2", "t3"]);
  assert.deepEqual(plan.toRewrite.map((x) => x.key), ["old-orphan", "orphan-a", "orphan-b"]);
  assert.equal(plan.alreadyOneThread, false);
});

test("planMerge: siblings sharing an unselected parent count as one thread", () => {
  const plan = C.planMerge([
    { key: 1, messageId: "<s1@x>", references: ["<gone@x>"], inReplyTo: [], date: 5 },
    { key: 2, messageId: "<s2@x>", references: [], inReplyTo: ["<gone@x>"], date: 6 },
    { key: 3, messageId: "<z@x>", references: [], inReplyTo: [], date: 1 },
  ]);
  assert.equal(plan.root.key, 1);
  assert.deepEqual(plan.toRewrite.map((x) => x.key), [3]);
});

test("planMerge: all singletons -> oldest becomes root", () => {
  const plan = C.planMerge([3, 1, 2].map((d) => ({ key: d, messageId: `<${d}@x>`, references: [], inReplyTo: [], date: d })));
  assert.equal(plan.root.key, 1);
  assert.deepEqual(plan.toRewrite.map((x) => x.key), [2, 3]);
});

test("binary helpers round trip", () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);
  assert.deepEqual(C.binaryToBytes(C.bytesToBinary(bytes)), bytes);
});
