/*
 * Rethread core: pure functions, no Thunderbird APIs.
 *
 * Messages are handled as "binary strings" (one char per byte, 0-255) so that
 * any charset or 8-bit body passes through byte-for-byte untouched. Only the
 * header block is edited.
 *
 * Thunderbird assigns a thread by walking the References list from the last
 * entry backwards and stopping at the first Message-ID it already has in the
 * folder (nsMsgDatabase::ThreadNewHdr). So a message joins a thread when the
 * thread root's Message-ID is the last entry of its References header.
 */
(function (root) {
  "use strict";

  const STASH_HEADER = "X-Rethread-Original";
  const MARK_HEADER = "X-Rethread";
  // Headers we drop on rewrite. X-Mozilla-* are local mbox bookkeeping lines;
  // Thunderbird writes fresh ones for the imported copy.
  const DROP_ALWAYS = new Set([
    "x-mozilla-status",
    "x-mozilla-status2",
    "x-mozilla-keys",
  ]);

  function bytesToBinary(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return s;
  }

  function binaryToBytes(s) {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
  }

  /** Split a raw message into header fields and the untouched remainder. */
  function parseMessage(raw) {
    // An mbox "From " envelope line is not a header; drop it.
    const envelope = /^From [^\n]*\n/.exec(raw);
    if (envelope) raw = raw.slice(envelope[0].length);

    const end = /\r?\n\r?\n/.exec(raw);
    const headerText = end ? raw.slice(0, end.index) : raw;
    const rest = end ? raw.slice(end.index) : "";
    const eol = headerText.includes("\r\n") || rest.startsWith("\r\n") ? "\r\n" : "\n";

    const fields = [];
    for (const line of headerText.split(/\r?\n/)) {
      if (/^[ \t]/.test(line) && fields.length) {
        fields[fields.length - 1].raw += eol + line;
      } else if (line.length) {
        const colon = line.indexOf(":");
        const name = (colon > 0 ? line.slice(0, colon) : line).trim().toLowerCase();
        fields.push({ name, raw: line });
      }
    }
    return { fields, rest, eol };
  }

  function serialize(msg) {
    const header = msg.fields.map((f) => f.raw).join(msg.eol);
    // A message without a body still needs the blank line after the header.
    return header + (msg.rest || msg.eol + msg.eol);
  }

  function fieldValue(field) {
    const colon = field.raw.indexOf(":");
    return field.raw.slice(colon + 1).replace(/\r?\n[ \t]+/g, " ").trim();
  }

  function getHeader(msg, name) {
    const f = msg.fields.find((x) => x.name === name.toLowerCase());
    return f ? fieldValue(f) : null;
  }

  /** All <msg-id> tokens in a header value, normalised to "<...>". */
  function extractIds(value) {
    if (!value) return [];
    const out = [];
    const re = /<([^<>]+)>/g;
    let m;
    while ((m = re.exec(value))) {
      const id = m[1].replace(/\s+/g, "");
      if (id) out.push("<" + id + ">");
    }
    return out;
  }

  function readThreadInfo(raw) {
    const msg = parseMessage(raw);
    return {
      messageId: extractIds(getHeader(msg, "Message-ID"))[0] || null,
      references: extractIds(getHeader(msg, "References")),
      inReplyTo: extractIds(getHeader(msg, "In-Reply-To")),
      rethreaded: msg.fields.some((f) => f.name === STASH_HEADER.toLowerCase()),
    };
  }

  /** Keep the last occurrence of each id, preserving order. */
  function dedupeKeepLast(ids) {
    const seen = new Set();
    const out = [];
    for (let i = ids.length - 1; i >= 0; i--) {
      if (!seen.has(ids[i])) {
        seen.add(ids[i]);
        out.unshift(ids[i]);
      }
    }
    return out;
  }

  /** "Name: a b c" folded so no line exceeds ~78 characters. */
  function foldTokens(name, tokens, eol) {
    const lines = [];
    let line = name + ":";
    for (const t of tokens) {
      if (line.length + 1 + t.length > 78 && line !== name + ":") {
        lines.push(line);
        line = "";
      }
      line += " " + t;
    }
    lines.push(line);
    return lines.join(eol);
  }

  // base64 of a binary string, without relying on btoa (absent in old node).
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function toBase64(s) {
    let out = "";
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
      out += i + 1 < s.length ? B64[(n >> 6) & 63] : "=";
      out += i + 2 < s.length ? B64[n & 63] : "=";
    }
    return out;
  }
  function fromBase64(s) {
    s = s.replace(/[^A-Za-z0-9+/]/g, "");
    let out = "";
    for (let i = 0; i < s.length; i += 4) {
      const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) |
        ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
      out += String.fromCharCode((n >> 16) & 255);
      if (i + 2 < s.length) out += String.fromCharCode((n >> 8) & 255);
      if (i + 3 < s.length) out += String.fromCharCode(n & 255);
    }
    return out;
  }

  function foldBase64(name, b64, eol) {
    const chunks = b64.match(/.{1,72}/g) || [""];
    return name + ": " + chunks.join(eol + " ");
  }

  /**
   * Make `raw` a reply to `rootId`.
   * opts: { rootId, rootReferences, date (ISO string), addMessageId }
   * The message keeps its own Message-ID, so replies to it still thread.
   * The original References/In-Reply-To lines are stashed (once) in
   * X-Rethread-Original so restoreOriginal() can undo the change exactly.
   */
  function rewriteIntoThread(raw, opts) {
    const msg = parseMessage(raw);
    const eol = msg.eol;
    const ownId = extractIds(getHeader(msg, "Message-ID"))[0] || opts.addMessageId || null;

    const isRef = (f) => f.name === "references" || f.name === "in-reply-to";
    const hasStash = msg.fields.some((f) => f.name === STASH_HEADER.toLowerCase());
    const stashFields = [];
    if (!hasStash) {
      const original = {
        references: (msg.fields.find((f) => f.name === "references") || {}).raw || null,
        inReplyTo: (msg.fields.find((f) => f.name === "in-reply-to") || {}).raw || null,
        eol,
      };
      stashFields.push({
        name: STASH_HEADER.toLowerCase(),
        raw: foldBase64(STASH_HEADER, toBase64(JSON.stringify(original)), eol),
      });
    }

    const currentRefs = extractIds(getHeader(msg, "References"));
    const currentIrt = extractIds(getHeader(msg, "In-Reply-To"));
    let refs = dedupeKeepLast([
      ...currentRefs,
      ...currentIrt,
      ...(opts.rootReferences || []),
      opts.rootId,
    ]).filter((id) => id !== ownId);
    // RFC 5322 suggests trimming very long chains; keep the first and the
    // last 40 so the root stays last.
    if (refs.length > 41) refs = [refs[0], ...refs.slice(-40)];

    msg.fields = msg.fields.filter(
      (f) => !isRef(f) && !DROP_ALWAYS.has(f.name) && f.name !== MARK_HEADER.toLowerCase(),
    );
    if (opts.addMessageId && !msg.fields.some((f) => f.name === "message-id")) {
      msg.fields.push({ name: "message-id", raw: "Message-ID: " + opts.addMessageId });
    }
    msg.fields.push({ name: "in-reply-to", raw: "In-Reply-To: " + opts.rootId });
    msg.fields.push({ name: "references", raw: foldTokens("References", refs, eol) });
    msg.fields.push(...stashFields);
    msg.fields.push({
      name: MARK_HEADER.toLowerCase(),
      raw: `${MARK_HEADER}: joined thread ${opts.rootId} on ${opts.date || new Date().toISOString()}`,
    });
    return serialize(msg);
  }

  /** Give a message without a Message-ID one, touching nothing else. */
  function addMessageId(raw, id) {
    const msg = parseMessage(raw);
    if (msg.fields.some((f) => f.name === "message-id")) return null;
    msg.fields = msg.fields.filter((f) => !DROP_ALWAYS.has(f.name));
    msg.fields.push({ name: "message-id", raw: "Message-ID: " + id });
    return serialize(msg);
  }

  /** Undo rewriteIntoThread(). Returns null if the message was never rethreaded. */
  function restoreOriginal(raw) {
    const msg = parseMessage(raw);
    const stash = msg.fields.find((f) => f.name === STASH_HEADER.toLowerCase());
    if (!stash) return null;
    const original = JSON.parse(fromBase64(fieldValue(stash)));
    const fix = (s) => s.replace(/\r?\n/g, msg.eol);
    msg.fields = msg.fields.filter(
      (f) =>
        f.name !== "references" &&
        f.name !== "in-reply-to" &&
        f.name !== STASH_HEADER.toLowerCase() &&
        f.name !== MARK_HEADER.toLowerCase() &&
        !DROP_ALWAYS.has(f.name),
    );
    if (original.inReplyTo) msg.fields.push({ name: "in-reply-to", raw: fix(original.inReplyTo) });
    if (original.references) msg.fields.push({ name: "references", raw: fix(original.references) });
    return serialize(msg);
  }

  /**
   * Decide what to change.
   * items: [{ key, messageId|null, references[], inReplyTo[], date(ms) }]
   * Messages already linked by Message-ID/References (directly, or through a
   * shared ancestor) form a group. The biggest group is the existing thread
   * and is left alone (ties go to the group with the oldest message); every
   * other message is pointed at that thread's oldest message.
   */
  function planMerge(items) {
    const parent = items.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const owner = new Map();
    items.forEach((it, i) => {
      for (const tok of [it.messageId, ...it.references, ...it.inReplyTo]) {
        if (!tok) continue;
        if (owner.has(tok)) parent[find(i)] = find(owner.get(tok));
        else owner.set(tok, i);
      }
    });

    const groups = new Map();
    items.forEach((it, i) => {
      const g = find(i);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it);
    });
    const byDate = (a, b) => a.date - b.date;
    const list = [...groups.values()].map((g) => g.sort(byDate));
    list.sort((a, b) => b.length - a.length || a[0].date - b[0].date);

    const target = list[0];
    const rootItem = target[0];
    const toRewrite = list.slice(1).flat().sort(byDate);
    return {
      root: rootItem,
      target,
      toRewrite,
      alreadyOneThread: list.length === 1,
    };
  }

  const api = {
    bytesToBinary,
    binaryToBytes,
    parseMessage,
    serialize,
    getHeader,
    extractIds,
    readThreadInfo,
    rewriteIntoThread,
    addMessageId,
    restoreOriginal,
    planMerge,
    toBase64,
    fromBase64,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RethreadCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
