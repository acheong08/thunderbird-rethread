/* Test-only: expose Thunderbird's internal thread assignment. */
"use strict";
var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var rethreadTest = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      rethreadTest: {
        async log(text) {
          dump("[selftest] " + text + "\n");
        },
        async report(text) {
          await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "rethread-report.json"), text);
        },
        async threadInfo(id) {
          const hdr = context.extension.messageManager.get(id);
          return { threadId: hdr.threadId, threadParent: hdr.threadParent, key: hdr.messageKey };
        },
      },
    };
  }
};
