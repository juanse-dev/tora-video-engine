import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";
import {backgroundAssets, toraPoseAssets} from "../src/assets.ts";
import {
  STAGED_LOCAL_ASSETS_DIR,
  resolveVisualAssetSrc,
  shortAssetId,
} from "../src/localAssets/sources.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const digest = `abcd${"0".repeat(56)}7890`;
const otherDigest = `1234${"f".repeat(56)}5678`;
const poseRef = `local:pose:sha256:${digest}`;
const backgroundRef = `local:background:sha256:${digest}`;
const otherPoseRef = `local:pose:sha256:${otherDigest}`;
const identity = (path) => path;
const staticFileLike = (path) => `/static/${path}`;

describe("ASSET-001 local asset composition contract", () => {
  it("exposes the staging directory name and a short asset id", () => {
    assert.equal(STAGED_LOCAL_ASSETS_DIR, "__local-assets");
    assert.equal(shortAssetId(poseRef), "abcd…7890");
    assert.equal(shortAssetId(backgroundRef), "abcd…7890");
  });

  it("resolves bundled values to the catalog preview path", () => {
    for (const [pose, path] of Object.entries(toraPoseAssets)) {
      assert.deepEqual(resolveVisualAssetSrc("pose", pose, undefined, identity), {
        kind: "image",
        src: path,
      });
    }

    for (const [background, path] of Object.entries(backgroundAssets)) {
      assert.deepEqual(
        resolveVisualAssetSrc("background", background, {}, identity),
        {kind: "image", src: path},
      );
    }
  });

  it("applies toStaticUrl to bundled paths", () => {
    assert.deepEqual(
      resolveVisualAssetSrc("pose", "formal", undefined, staticFileLike),
      {kind: "image", src: "/static/characters/tora/formal.png"},
    );
  });

  it("ignores source entries for bundled values", () => {
    assert.deepEqual(
      resolveVisualAssetSrc(
        "pose",
        "formal",
        {[poseRef]: {kind: "url", url: "blob:x"}},
        identity,
      ),
      {kind: "image", src: toraPoseAssets.formal},
    );
  });

  it("resolves a url source to that URL untouched", () => {
    assert.deepEqual(
      resolveVisualAssetSrc(
        "pose",
        poseRef,
        {[poseRef]: {kind: "url", url: "blob:http://x/abc"}},
        staticFileLike,
      ),
      {kind: "image", src: "blob:http://x/abc"},
    );
  });

  it("resolves a static source through toStaticUrl", () => {
    assert.deepEqual(
      resolveVisualAssetSrc(
        "background",
        backgroundRef,
        {[backgroundRef]: {kind: "static", path: "__local-assets/background/a.png"}},
        staticFileLike,
      ),
      {kind: "image", src: "/static/__local-assets/background/a.png"},
    );
  });

  it("resolves a pending source to pending", () => {
    assert.deepEqual(
      resolveVisualAssetSrc(
        "pose",
        poseRef,
        {[poseRef]: {kind: "pending"}},
        identity,
      ),
      {kind: "pending", category: "pose", ref: poseRef},
    );
  });

  it("resolves a local ref without an entry to missing with the right category", () => {
    assert.deepEqual(
      resolveVisualAssetSrc("pose", poseRef, undefined, identity),
      {kind: "missing", category: "pose", ref: poseRef},
    );
    assert.deepEqual(
      resolveVisualAssetSrc("background", backgroundRef, {}, identity),
      {kind: "missing", category: "background", ref: backgroundRef},
    );
    assert.deepEqual(
      resolveVisualAssetSrc(
        "pose",
        poseRef,
        {[otherPoseRef]: {kind: "url", url: "blob:other"}},
        identity,
      ),
      {kind: "missing", category: "pose", ref: poseRef},
    );
  });

  it("never resolves a ref from another category's entry", () => {
    const sources = {[backgroundRef]: {kind: "url", url: "blob:bg"}};

    assert.equal(
      resolveVisualAssetSrc("pose", poseRef, sources, identity).kind,
      "missing",
    );
    assert.equal(
      resolveVisualAssetSrc("background", backgroundRef, sources, identity).kind,
      "image",
    );
    assert.equal(
      resolveVisualAssetSrc(
        "background",
        backgroundRef,
        {[poseRef]: {kind: "url", url: "blob:pose"}},
        identity,
      ).kind,
      "missing",
    );
  });

  it("does not resolve prototype keys as source entries", () => {
    assert.equal(
      resolveVisualAssetSrc("pose", poseRef, Object.create({[poseRef]: {kind: "url", url: "blob:inherited"}}), identity).kind,
      "missing",
    );
  });

  it("Tora and Background resolve through the hook and keep object-fit", async () => {
    const tora = await read("src/components/Tora.tsx");
    const background = await read("src/components/Background.tsx");

    assert.match(tora, /useVisualAssetSrc\(/);
    assert.match(tora, /objectFit: "contain"/);
    assert.match(tora, /MissingAssetPlaceholder/);
    assert.match(background, /useVisualAssetSrc\(/);
    assert.match(background, /objectFit: "cover"/);
    assert.match(background, /MissingAssetPlaceholder/);

    for (const source of [tora, background]) {
      assert.doesNotMatch(source, /drawn by a later task/);
    }
  });

  it("placeholder exposes missing/pending markers and uses assetRef", async () => {
    const source = await read("src/components/MissingAssetPlaceholder.tsx");

    assert.match(source, /data-missing-local-asset/);
    assert.match(source, /data-pending-local-asset/);
    assert.match(source, /assetRef/);
    assert.match(source, /shortAssetId/);
    assert.match(source, /role="img"/);
    assert.match(source, /#1f2430/);
    assert.match(source, /#2b3140/);
  });

  it("ToraVideo accepts localAssetSources and wraps the renderer in the provider", async () => {
    const source = await read("src/Video.tsx");

    assert.match(source, /localAssetSources\?: LocalAssetSourceMap/);
    assert.match(source, /<LocalAssetSourcesProvider sources=\{localAssetSources\}>/);
  });

  it("the hook module reads only context (no storage, window, network or fs)", async () => {
    const source = await read("src/components/visualAssetSource.tsx");

    for (const forbidden of ["indexedDB", "window", "fetch(", "node:fs", "localStorage"]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
    assert.match(source, /createContext/);
    assert.match(source, /resolveVisualAssetSrc/);
  });
});
