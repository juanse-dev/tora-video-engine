import assert from "node:assert/strict";
import {join, resolve} from "node:path";
import {describe, it} from "node:test";
import {
  AUDIO_RENDER_ARGS,
  buildRenderArgs,
  COMPOSITION_ID,
  getOutputPath,
  getRemotionBrowserExecutable,
  getRemotionCliPath,
  getRemotionExecutable,
  getStoryPath,
  getStorySlug,
  REMOTION_ENTRY_POINT,
} from "../scripts/renderSupport.ts";

describe("render command support", () => {
  it("requires exactly one story path", () => {
    assert.throws(
      () => getStoryPath([]),
      /Missing story path/,
    );
    assert.throws(
      () => getStoryPath(["one.yaml", "two.yaml"]),
      /exactly one story path/,
    );
    assert.equal(
      getStoryPath(["stories/friday-deploy.yaml"]),
      "stories/friday-deploy.yaml",
    );
  });

  it("derives a stable slug and output path from the input filename", () => {
    assert.equal(
      getStorySlug("stories/friday-deploy.yaml"),
      "friday-deploy",
    );
    assert.equal(
      getOutputPath("stories/friday-deploy.yaml"),
      join("output", "friday-deploy.mp4"),
    );
    assert.equal(
      getOutputPath("stories/Deploy de Tóra!.yml"),
      join("output", "deploy-de-tora.mp4"),
    );
  });

  it("rejects filenames that cannot produce an output slug", () => {
    assert.throws(
      () => getOutputPath("stories/😀.yaml"),
      /Could not derive an output filename/,
    );
  });

  it("launches the Remotion JavaScript CLI through the current Node executable", () => {
    assert.equal(getRemotionExecutable(), process.execPath);
    assert.equal(
      getRemotionCliPath(),
      resolve(
        "node_modules",
        "@remotion",
        "cli",
        "remotion-cli.js",
      ),
    );
  });

  it("builds a deterministic H.264 Remotion invocation", () => {
    const previous =
      process.env.TORA_REMOTION_BROWSER_EXECUTABLE;
    delete process.env.TORA_REMOTION_BROWSER_EXECUTABLE;

    try {
      assert.equal(getRemotionBrowserExecutable(), null);
      assert.deepEqual(
        buildRenderArgs(
          "output/friday-deploy.mp4",
          "/tmp/tora/props.json",
        ),
        [
          getRemotionCliPath(),
          "render",
          REMOTION_ENTRY_POINT,
          COMPOSITION_ID,
          "output/friday-deploy.mp4",
          "--codec=h264",
          "--overwrite=true",
          "--props=/tmp/tora/props.json",
        ],
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TORA_REMOTION_BROWSER_EXECUTABLE;
      } else {
        process.env.TORA_REMOTION_BROWSER_EXECUTABLE = previous;
      }
    }
  });

  it("uses an explicit CI browser without changing local defaults", () => {
    const previous =
      process.env.TORA_REMOTION_BROWSER_EXECUTABLE;
    process.env.TORA_REMOTION_BROWSER_EXECUTABLE =
      " /usr/bin/google-chrome ";

    try {
      assert.equal(
        getRemotionBrowserExecutable(),
        "/usr/bin/google-chrome",
      );
      assert.ok(
        buildRenderArgs(
          "output/friday-deploy.mp4",
          "/tmp/tora/props.json",
        ).includes(
          "--browser-executable=/usr/bin/google-chrome",
        ),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TORA_REMOTION_BROWSER_EXECUTABLE;
      } else {
        process.env.TORA_REMOTION_BROWSER_EXECUTABLE = previous;
      }
    }
  });

  describe("audio arguments (D-14)", () => {
    const withoutBrowser = (run) => {
      const previous = process.env.TORA_REMOTION_BROWSER_EXECUTABLE;

      delete process.env.TORA_REMOTION_BROWSER_EXECUTABLE;

      try {
        run();
      } finally {
        if (previous === undefined) {
          delete process.env.TORA_REMOTION_BROWSER_EXECUTABLE;
        } else {
          process.env.TORA_REMOTION_BROWSER_EXECUTABLE = previous;
        }
      }
    };

    it("hasAudio: false is byte-for-byte the v0.3 list, with and without a public dir", () => {
      withoutBrowser(() => {
        const v03 = (publicDir) => [
          getRemotionCliPath(),
          "render",
          REMOTION_ENTRY_POINT,
          COMPOSITION_ID,
          "output/story.mp4",
          "--codec=h264",
          "--overwrite=true",
          "--props=/tmp/tora/props.json",
          ...(publicDir === undefined ? [] : [`--public-dir=${publicDir}`]),
        ];

        for (const publicDir of [undefined, "/tmp/tora/public"]) {
          assert.deepEqual(
            buildRenderArgs("output/story.mp4", "/tmp/tora/props.json", publicDir, {
              hasAudio: false,
            }),
            v03(publicDir),
          );
          assert.deepEqual(
            buildRenderArgs("output/story.mp4", "/tmp/tora/props.json", publicDir),
            v03(publicDir),
          );
        }
      });
    });

    it("hasAudio: true appends --audio-codec=aac, --audio-bitrate=128k and --enforce-audio-track exactly once", () => {
      withoutBrowser(() => {
        const args = buildRenderArgs(
          "output/story.mp4",
          "/tmp/tora/props.json",
          "/tmp/tora/public",
          {hasAudio: true},
        );

        assert.deepEqual(AUDIO_RENDER_ARGS, [
          "--audio-codec=aac",
          "--audio-bitrate=128k",
          "--enforce-audio-track",
        ]);
        assert.equal(args.filter((arg) => arg === "--audio-codec=aac").length, 1);
        assert.equal(args.filter((arg) => arg === "--audio-bitrate=128k").length, 1);
        assert.equal(args.filter((arg) => arg === "--enforce-audio-track").length, 1);
        assert.deepEqual(args.slice(-3), AUDIO_RENDER_ARGS);
        assert.ok(args.includes("--public-dir=/tmp/tora/public"));
        assert.ok(!args.some((arg) => arg === "--muted"));
      });
    });

    it("the silent argument list never carries an audio flag, enforce-audio-track included (AINV-6)", () => {
      withoutBrowser(() => {
        for (const options of [undefined, {}, {hasAudio: false}]) {
          const args = buildRenderArgs("output/story.mp4", "/tmp/tora/props.json", "/tmp/tora/public", options);

          assert.ok(!args.some((arg) => arg === "--enforce-audio-track" || arg.startsWith("--audio-")));
        }
      });
    });
  });
});
