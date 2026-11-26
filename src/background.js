/* global browser, RethreadCore */
"use strict";

const MENU_MERGE = "rethread-merge";
const MENU_UNDO = "rethread-undo";

const {
  bytesToBinary,
  binaryToBytes,
  readThreadInfo,
  rewriteIntoThread,
  addMessageId,
  restoreOriginal,
  planMerge,
} = RethreadCore;

// ---------------------------------------------------------------- menus

async function setupMenus() {
  await browser.menus.removeAll();
  browser.menus.create({
    id: MENU_MERGE,
    title: "Merge into one thread",
    contexts: ["message_list"],
  });
  browser.menus.create({
    id: MENU_UNDO,
    title: "Undo Rethread (restore original headers)",
    contexts: ["message_list"],
  });
}
browser.runtime.onInstalled.addListener(setupMenus);
browser.runtime.onStartup.addListener(setupMenus);

let busy = false;
browser.menus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_MERGE && info.menuItemId !== MENU_UNDO) return;
  if (busy) {
    notify("Rethread is still working", "Wait for the current operation to finish.");
    return;
  }
  busy = true;
  try {
    const messages = await collectSelection(info.selectedMessages);
    if (info.menuItemId === MENU_MERGE) await mergeIntoThread(messages);
    else await undoRethread(messages);
  } catch (e) {
    console.error("Rethread failed", e);
    notify("Rethread failed", String((e && e.message) || e));
  } finally {
    busy = false;
  }
});

// -------------------------------------------------------------- helpers

function notify(title, message) {
  return browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("icon.svg"),
    title,
    message,
  });
}

async function collectSelection(list) {
  if (!list) return [];
  const out = [...list.messages];
  while (list.id) {
    list = await browser.messages.continueList(list.id);
    out.push(...list.messages);
  }
  return out;
}

async function readRaw(messageId) {
  const file = await browser.messages.getRaw(messageId, { data_format: "File" });
  return bytesToBinary(new Uint8Array(await file.arrayBuffer()));
}

function requireSingleFolder(messages) {
  const folders = new Set(messages.map((m) => m.folder && m.folder.id));
  if (folders.size !== 1 || folders.has(undefined)) {
    throw new Error(
      "The selected messages are in different folders. Thunderbird threads " +
        "only within one folder, so move them into the same folder first.",
    );
  }
  return messages[0].folder;
}

function randomMessageId() {
  return `<rethread.${crypto.randomUUID()}@rethread.invalid>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Replace `header` (a MessageHeader) by `newRaw` in the same folder.
 * messages.import() refuses a Message-ID the folder already contains, so the
 * original is deleted first (honoring the account's delete setting, normally
 * Trash). If the import fails, the original bytes are imported back.
 */
async function replaceMessage(header, oldRaw, newRaw) {
  const folderId = header.folder.id;
  const toFile = (raw) => new File([binaryToBytes(raw)], "message.eml", { type: "message/rfc822" });
  const props = {
    read: !!header.read,
    flagged: !!header.flagged,
    tags: header.tags || [],
    new: false,
  };

  await browser.messages.delete([header.id]);

  // IMAP servers without the MOVE extension can leave the deleted copy in
  // the folder briefly; retry before giving up.
  const importWithRetry = async (raw) => {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await browser.messages.import(toFile(raw), folderId, props);
      } catch (e) {
        lastError = e;
        await sleep(750 * (attempt + 1));
      }
    }
    throw lastError;
  };

  try {
    return await importWithRetry(newRaw);
  } catch (e) {
    const restored = await importWithRetry(oldRaw).then(() => true, () => false);
    throw new Error(
      `Could not re-import "${header.subject}": ${(e && e.message) || e}` +
        (restored ? " (the original was put back)" : " (the original is in the Trash)"),
    );
  }
}

// ---------------------------------------------------------------- merge

async function mergeIntoThread(messages) {
  if (messages.length < 2) {
    notify("Rethread", "Select at least two messages to merge into one thread.");
    return;
  }
  requireSingleFolder(messages);

  const items = [];
  for (const header of messages) {
    const raw = await readRaw(header.id);
    const info = readThreadInfo(raw);
    items.push({
      key: header.id,
      header,
      raw,
      messageId: info.messageId,
      references: info.references,
      inReplyTo: info.inReplyTo,
      date: new Date(header.date).getTime(),
    });
  }

  const plan = planMerge(items);
  if (plan.alreadyOneThread && plan.root.messageId) {
    notify(
      "Rethread",
      "These messages are already linked into one thread by their headers. " +
        "If they still show separately, check that View > Sort by > Threaded is on.",
    );
    return;
  }

  const now = new Date().toISOString();
  let rootId = plan.root.messageId;

  // A root without a Message-ID header cannot be referenced; give it one.
  if (!rootId) {
    rootId = randomMessageId();
    await replaceMessage(plan.root.header, plan.root.raw, addMessageId(plan.root.raw, rootId));
  }

  const toRewrite = plan.alreadyOneThread ? [] : plan.toRewrite;
  let done = 0;
  for (const item of toRewrite) {
    const newRaw = rewriteIntoThread(item.raw, {
      rootId,
      rootReferences: plan.root.references,
      date: now,
      addMessageId: item.messageId ? null : randomMessageId(),
    });
    await replaceMessage(item.header, item.raw, newRaw);
    done++;
  }

  notify(
    "Rethread: thread merged",
    `${done} message(s) now reply to "${plan.root.header.subject}".`,
  );
}

// ----------------------------------------------------------------- undo

async function undoRethread(messages) {
  if (!messages.length) return;
  requireSingleFolder(messages);
  let restored = 0;
  for (const header of messages) {
    const raw = await readRaw(header.id);
    const restoredRaw = restoreOriginal(raw);
    if (!restoredRaw) continue;
    await replaceMessage(header, raw, restoredRaw);
    restored++;
  }
  notify(
    "Rethread",
    restored
      ? `Restored the original threading headers of ${restored} message(s).`
      : "None of the selected messages were changed by Rethread.",
  );
}
