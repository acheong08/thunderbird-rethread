# Rethread

A Thunderbird add-on that merges selected messages into one thread. Select the
messages, right-click, and choose **Merge into one thread**.

It is for mail that should be one conversation but isn't, such as support
tickets where every reply arrives as a new message.

Requires Thunderbird 128 or later. Tested end to end on Thunderbird 161.

## Install

1. Download `rethread-<version>.xpi` from the
   [latest release](https://github.com/acheong08/thunderbird-rethread/releases/latest).
2. In Thunderbird, open Tools > Add-ons and Themes.
3. Click the gear icon, then Install Add-on From File, and pick the file.

To build the file yourself, run `./build.sh`; it writes to `dist/`.

## Use

Select the messages to merge (shift- or ctrl-click; a collapsed thread counts
as all of its messages), right-click one of them, and choose **Merge into one
thread**.

- If some of the selected messages already form a thread, that thread is kept
  as it is and the others are attached under its first message.
- If none of them are linked, the oldest one becomes the start of a new thread
  and the rest are attached under it.

When it finishes, Thunderbird shows a notification with the number of messages
it changed.

**Undo Rethread** in the same menu puts back the original headers of the
selected messages.

## How it works

Thunderbird builds threads from the `References` and `In-Reply-To` headers. To
find a message's parent, it walks `References` from the last entry backwards
and uses the first Message-ID it already has in the folder.

For each message it attaches, Rethread:

1. Sets `In-Reply-To` to the thread root's Message-ID and appends the root's
   Message-ID as the last entry of `References`. The message keeps its own
   Message-ID, so a later reply to it (for example from rsync.net support to
   their own ticket mail) lands in the same thread.
2. Saves the original `References` and `In-Reply-To` lines in an
   `X-Rethread-Original` header. Undo restores them from there.
3. Deletes the original, which follows the account's delete setting (normally
   it goes to Trash).
4. Imports the rewritten copy into the original folder with the same read,
   starred and tag state.

The original has to leave the folder first because Thunderbird will not import
a message into a folder that already has its Message-ID. If the import fails,
the add-on imports the original back.

Messages that have no Message-ID get one of the form
`<rethread.UUID@rethread.invalid>`, because a message can't be replied to
without one.

Only the header block is edited. The body and attachments are copied byte for
byte.

## Things to know

- **Back up first.** Rethread rewrites messages. The originals go to Trash
  (unless the account deletes immediately), so check the result before you
  empty it.
- Threads exist only within one folder, so all selected messages must be in
  the same folder.
- The "replied" and "forwarded" arrows are lost on rewritten messages, because
  the add-on API has no way to set them on an imported message.
- Rewriting `References` breaks DKIM signatures that cover it. Thunderbird
  doesn't check DKIM, but a server that re-verifies stored mail would.
- New mail that starts a fresh ticket (no reference to any earlier message)
  still arrives as a separate thread. You can merge it the same way.
- On Gmail, appending a message whose Message-ID already exists may be ignored
  by the server. This was not tested.
- On IMAP servers without the MOVE extension, the moved original can linger in
  the source folder until it's expunged. Rethread retries the import a few
  times; if it still fails, it imports the original back and reports the error.

## Tests

```sh
node --test test/core.test.js          # header rewriting and planning
test/e2e/run.sh /path/to/thunderbird   # real Thunderbird, throwaway profile
```

The end-to-end test starts Thunderbird headless with a new profile and a
test-only Experiment API that reads Thunderbird's internal thread IDs. It
imports an existing 3-message thread, three ticket mails (one with a reply,
one without a Message-ID), merges them, and checks that:

- all of them end up in one Thunderbird thread under the original first message;
- read, starred, tags and an 8-bit body survive;
- the existing thread's messages are not modified;
- a new reply to a merged message joins the thread;
- running the merge again changes nothing;
- undo removes the added headers and the message leaves the thread.

On macOS the binary is `Thunderbird.app/Contents/MacOS/thunderbird`.

## Releasing

Bump `version` in `src/manifest.json`, commit, then push a matching tag:

```sh
git tag v1.2.0 && git push origin v1.2.0
```

The Release workflow runs the unit tests, builds the .xpi and attaches it to
a new GitHub release. It fails if the tag and manifest version differ.
