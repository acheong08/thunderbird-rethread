/* global browser, mergeIntoThread, undoRethread */
// E2E self-test: runs inside a real Thunderbird with the real background.js.
// Writes its report to <profile>/rethread-report.json via the test experiment.
"use strict";

// Diagnostic breadcrumb that needs no experiment: a folder named after state.
browser.accounts.list(false).then((a) => {
  const l = a.find((x) => x.type === "local" || x.type === "none");
  return browser.folders.create(l.rootFolder.id, "DIAG-" + typeof browser.rethreadTest);
}).catch(() => {});

const log = [];
const say = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); log.push(s); browser.rethreadTest.log(s).catch(() => {}); };
let failures = 0;
const check = (cond, what) => { if (!cond) failures++; say(cond ? "PASS" : "FAIL", what); };

const eml = (headers, body = "Body\r\n") =>
  new File([headers.join("\r\n") + "\r\n\r\n" + body], "m.eml", { type: "message/rfc822" });

async function listAll(folderId) {
  let l = await browser.messages.list(folderId);
  const out = [...l.messages];
  while (l.id) { l = await browser.messages.continueList(l.id); out.push(...l.messages); }
  return out;
}
const tinfo = (id) => browser.rethreadTest.threadInfo(id);

async function run() {
  await new Promise((r) => setTimeout(r, 4000));
  say("selftest started");
  const accounts = await browser.accounts.list(false);
  const local = accounts.find((a) => a.type === "local" || a.type === "none");
  say("accounts", accounts.map((a) => a.type + ":" + a.name));
  const folder = await browser.folders.create(local.rootFolder.id, "E2E");

  const H = (id, subj, date, extra = []) => [
    "From: rsync.net Customer Support <support@rsync.net>",
    "To: me@duti.dev",
    `Subject: ${subj}`,
    `Date: ${date}`,
    ...(id ? [`Message-ID: ${id}`] : []),
    ...extra,
    "Content-Type: text/plain; charset=UTF-8",
  ];
  // An existing 3-message thread ...
  await browser.messages.import(eml(H("<t1@x>", "Zurich location availability?", "Mon, 23 Nov 2026 15:00:00 +0000")), folder.id, { read: true });
  await browser.messages.import(eml(H("<t2@x>", "Re: Zurich location availability?", "Mon, 23 Nov 2026 15:18:00 +0000", ["In-Reply-To: <t1@x>", "References: <t1@x>"])), folder.id, { read: true });
  await browser.messages.import(eml(H("<t3@x>", "Re: Zurich location availability?", "Tue, 24 Nov 2026 07:40:00 +0000", ["In-Reply-To: <t2@x>", "References: <t1@x> <t2@x>"])), folder.id, { read: true });
  // ... ticket mails that started new threads ...
  await browser.messages.import(eml(H("<o1@x>", "Your rsync.net filesystem is ready!", "Tue, 24 Nov 2026 13:04:00 +0000"), "Gr\u00fc\u00dfe \u2603\r\n"), folder.id, { read: true, flagged: true, tags: ["$label1"] });
  await browser.messages.import(eml(H("<o2@x>", "rsync.net Account Manager - Important", "Tue, 24 Nov 2026 13:05:00 +0000")), folder.id, { read: false });
  await browser.messages.import(eml(H("<r1@x>", "Re: Your rsync.net filesystem is ready!", "Tue, 24 Nov 2026 14:00:00 +0000", ["In-Reply-To: <o1@x>", "References: <o1@x>"])), folder.id, { read: true });
  // ... and one without any Message-ID.
  await browser.messages.import(eml(H(null, "Sub Account for account zh6741 is now ready", "Tue, 24 Nov 2026 17:45:00 +0000")), folder.id, { read: true });

  let msgs = await listAll(folder.id);
  check(msgs.length === 7, `imported 7 messages (got ${msgs.length})`);
  const before = new Set();
  for (const m of msgs) before.add((await tinfo(m.id)).threadId);
  say("threads before merge:", before.size);

  // ---- merge everything
  await mergeIntoThread(msgs);

  msgs = await listAll(folder.id);
  check(msgs.length === 7, `still 7 messages in folder (got ${msgs.length})`);
  const infos = [];
  for (const m of msgs) infos.push({ m, t: await tinfo(m.id) });
  const threads = new Set(infos.map((x) => x.t.threadId));
  check(threads.size === 1, `all messages in ONE Thunderbird thread (threads: ${threads.size})`);
  for (const x of infos) say("  ", x.m.subject, "| id", x.m.headerMessageId, "| thread", x.t.threadId, "| parentKey", x.t.threadParent);

  const t1 = msgs.find((m) => m.headerMessageId === "t1@x");
  const o1 = msgs.find((m) => m.headerMessageId === "o1@x");
  const o2 = msgs.find((m) => m.headerMessageId === "o2@x");
  check(t1 && infos.find((x) => x.m.id === t1.id).t.threadParent === 0xffffffff, "t1 is the thread root");
  check(o1 && o1.flagged && o1.read && (o1.tags || []).includes("$label1"), "flag/read/tags preserved on o1");
  check(o2 && !o2.read, "unread state preserved on o2");
  const raw = await (await browser.messages.getRaw(o1.id, { data_format: "File" })).text();
  check(raw.includes("Gr\u00fc\u00dfe \u2603"), "o1 body intact (UTF-8)");
  check(/References: <t1@x>/.test(raw) && /In-Reply-To: <t1@x>/.test(raw), "o1 references the root");
  const noId = msgs.find((m) => m.subject.startsWith("Sub Account"));
  check(noId && /^rethread\./.test(noId.headerMessageId), "message without Message-ID got one: " + (noId && noId.headerMessageId));

  const subs = await browser.folders.getSubFolders(local.rootFolder.id, false);
  check(!subs.some((f) => f.name === "Rethread Backup"), "no backup folder created");
  const trash = subs.find((f) => f.specialUse && f.specialUse.includes("trash"));
  const trashed = trash ? await listAll(trash.id) : [];
  check(trashed.length === 4, `4 originals went to Trash (got ${trashed.length})`);

  // ---- merging an already-merged set is a no-op
  const nTrash = (await listAll(trash.id)).length;
  await mergeIntoThread(await listAll(folder.id));
  check((await listAll(trash.id)).length === nTrash, "re-merging an already-merged thread changes nothing");

  // ---- untouched thread members were not rewritten
  const t2raw = await (await browser.messages.getRaw(msgs.find((m) => m.headerMessageId === "t2@x").id, { data_format: "File" })).text();
  check(!t2raw.includes("X-Rethread"), "existing thread members untouched");

  // ---- a NEW reply to a merged ticket mail joins the thread
  await browser.messages.import(eml(H("<new@x>", "Re: rsync.net Account Manager - Important", "Wed, 25 Nov 2026 09:00:00 +0000", ["In-Reply-To: <o2@x>", "References: <o2@x>"])), folder.id, {});
  msgs = await listAll(folder.id);
  const fresh = msgs.find((m) => m.headerMessageId === "new@x");
  const rootThread = [...threads][0];
  check((await tinfo(fresh.id)).threadId === rootThread, "new incoming reply to a merged message joins the thread");

  // ---- undo on a merged message nobody replies to
  const subj = (m) => m.subject.startsWith("Sub Account");
  await undoRethread([msgs.find(subj)]);
  msgs = await listAll(folder.id);
  const undone = msgs.find(subj);
  const undoneRaw = await (await browser.messages.getRaw(undone.id, { data_format: "File" })).text();
  check(!/X-Rethread|References:|In-Reply-To:/.test(undoneRaw), "undo removed the added headers");
  check((await tinfo(undone.id)).threadId !== rootThread, "undone message left the thread");
  check(msgs.length === 8, `no messages lost (got ${msgs.length}, expected 8)`);
}

run()
  .catch((e) => { failures++; say("ERROR", String(e), e && e.stack); })
  .finally(() =>
    browser.rethreadTest.report(JSON.stringify({ failures, log })));
