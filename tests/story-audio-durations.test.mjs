import assert from "node:assert/strict";
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {
  localAudioRefsKey,
  parseLocalAudioRefsKey,
  sameDurationMap,
} from "../src/web/useStoryAudioDurations.ts";

const audioRef = (n) => `local:audio:sha256:${n.toString(16).padStart(64, "0")}`;
const scene = (extra = {}) => ({type: "intro", pose: "formal", background: "office", text: "Hi", duration: 3, ...extra});

describe("localAudioRefsKey", () => {
  it("lists the Story's distinct local audio refs, sorted, without bundled sounds", () => {
    const story = {
      title: "T",
      music: {src: audioRef(3)},
      scenes: [scene({sfx: {src: "boom"}, voice: {src: audioRef(2)}}), scene({sfx: {src: audioRef(3)}, voice: {src: audioRef(1)}})],
    };

    assert.equal(localAudioRefsKey(story), [audioRef(1), audioRef(2), audioRef(3)].join(","));
    assert.deepEqual(parseLocalAudioRefsKey(localAudioRefsKey(story)), [audioRef(1), audioRef(2), audioRef(3)]);
  });

  it("is empty for a Story without local audio and does not depend on scene order", () => {
    assert.equal(localAudioRefsKey({title: "T", scenes: [scene({sfx: {src: "ding"}})]}), "");
    assert.deepEqual(parseLocalAudioRefsKey(""), []);

    const a = {title: "T", scenes: [scene({voice: {src: audioRef(1)}}), scene({voice: {src: audioRef(2)}})]};
    const b = {title: "T", scenes: [...a.scenes].reverse()};

    assert.equal(localAudioRefsKey(a), localAudioRefsKey(b));
  });
});

describe("sameDurationMap", () => {
  it("is entry-wise equality", () => {
    assert.equal(sameDurationMap({}, {}), true);
    assert.equal(sameDurationMap({[audioRef(1)]: 2.2}, {[audioRef(1)]: 2.2}), true);
    assert.equal(sameDurationMap({[audioRef(1)]: 2.2}, {[audioRef(1)]: 2.3}), false);
    assert.equal(sameDurationMap({[audioRef(1)]: 2.2}, {}), false);
    assert.equal(sameDurationMap({[audioRef(1)]: 2.2}, {[audioRef(2)]: 2.2}), false);
  });
});

describe("one duration map per page (AUDIO-001 final-review follow-up)", () => {
  const walk = (directory) =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);

      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  it("App and Preview never build their own map: only the hook (and the interim render path) call storyAudioDurations", () => {
    const callers = walk("src/web")
      .filter((path) => /\.(ts|tsx)$/u.test(path))
      .filter((path) => /\bstoryAudioDurations\(/u.test(readFileSync(path, "utf8")))
      .map((path) => path.replaceAll("\\", "/"))
      .sort();

    assert.deepEqual(callers, ["src/web/browserRender.ts", "src/web/useStoryAudioDurations.ts"]);
  });

  it("App passes the hook's map to the Player config and to Preview", () => {
    const app = readFileSync("src/web/App.tsx", "utf8");

    assert.match(app, /const audioDurations = useStoryAudioDurations\(/u);
    assert.match(app, /getWebPlayerConfig\(activeStory, audioDurations\)/u);
    assert.match(app, /audioDurations=\{audioDurations\}/u);
  });
});
