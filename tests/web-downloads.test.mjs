import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  downloadBlob,
  getDownloadBasename,
  getMp4DownloadFilename,
} from "../src/web/downloads.ts";

describe("WEB-006 MP4 downloads", () => {
  it("reuses the bounded WEB-005 basename sanitizer", () => {
    assert.equal(
      getMp4DownloadFilename("Deploy Friday"),
      "Deploy-Friday.mp4",
    );
    assert.equal(getMp4DownloadFilename("CON"), "tora-CON.mp4");
    assert.ok(
      new TextEncoder().encode(
        getDownloadBasename("猫".repeat(100)),
      ).byteLength <= 96,
    );
  });

  it("downloads the exact public Blob without materializing a second payload", () => {
    const blob = new Blob(["public-remotion-blob"], {type: "video/mp4"});
    const events = [];
    const anchor = {
      href: "",
      download: "",
      click() {
        events.push(["click", this.href, this.download]);
      },
    };
    const documentRef = {
      createElement(tag) {
        assert.equal(tag, "a");
        return anchor;
      },
    };
    const urlRef = {
      createObjectURL(value) {
        assert.equal(value, blob);
        events.push(["create", value]);
        return "blob:tora-test";
      },
      revokeObjectURL(url) {
        events.push(["revoke", url]);
      },
    };

    downloadBlob(
      blob,
      getMp4DownloadFilename("Deploy Friday"),
      documentRef,
      urlRef,
    );

    assert.deepEqual(events, [
      ["create", blob],
      ["click", "blob:tora-test", "Deploy-Friday.mp4"],
      ["revoke", "blob:tora-test"],
    ]);
  });
});
