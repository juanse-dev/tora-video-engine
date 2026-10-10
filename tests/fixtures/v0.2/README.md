# v0.2 compatibility fixtures

Real output of the **v0.2 code**, used by `tests/browser/local-assets-portability.spec.mjs`
to prove that v0.3 still exports and restores bundled-only projects exactly as v0.2 did
(`docs/assets/ASSET-006-persistence-and-production-verification.md`, task A2).

There is no v0.2 tag. The baseline is commit `962e030473087025ded13f3135e43fa638fdc9d9`
(main just before ASSET-001; v0.2 code plus the v0.3 docs).

| File | Produced by (at 962e030) |
| --- | --- |
| `friday-deploy.yaml`, `ci-smoke.yaml`, `demo-reel.yaml` | `serializeStorySource(parseStorySource(<stories/NAME.yaml>))`, the YAML that v0.2 exports for each bundled Story |
| `project-envelope.json` | `serializePersistedEnvelope(story)`, the `localStorage["tora-video-engine:project"]` value v0.2 writes (`version: 1`). The Story is `friday-deploy` with scene 1 text changed to `Written by v0.2`. |

`.gitattributes` marks these files `-text` so Git never rewrites line endings: the tests
compare them byte for byte.

## Regenerating

Only needed if the bundled Stories change. Never regenerate from current code: the point
is that these come from v0.2.

```sh
git worktree add --detach ../tora-video-engine-wt-v02 962e030
# the worktree needs the dependencies; link the main checkout's node_modules into it
# (Windows: cmd //c "mklink /J <worktree>\node_modules <checkout>\node_modules")
node --experimental-strip-types gen-v02.mjs <worktree> tests/fixtures/v0.2
# remove the node_modules link first, then:
git worktree remove --force ../tora-video-engine-wt-v02
```

`gen-v02.mjs` is a throwaway script (not committed):

```js
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const [, , root, outDir] = process.argv;
const load = (path) => import(pathToFileURL(join(root, path)).href);
const {parseStorySource} = await load("src/story/parseStory.ts");
const {serializeStorySource} = await load("src/story/serializeStory.ts");
const {serializePersistedEnvelope} = await load("src/web/persistence.ts");

await mkdir(outDir, {recursive: true});

for (const name of ["friday-deploy", "ci-smoke", "demo-reel"]) {
  const source = await readFile(join(root, "stories", `${name}.yaml`), "utf8");
  const story = parseStorySource(source, `${name}.yaml`);

  await writeFile(join(outDir, `${name}.yaml`), serializeStorySource(story));

  if (name === "friday-deploy") {
    const edited = {
      ...story,
      scenes: story.scenes.map((scene, index) =>
        index === 0 ? {...scene, text: "Written by v0.2"} : scene,
      ),
    };

    await writeFile(
      join(outDir, "project-envelope.json"),
      serializePersistedEnvelope(edited),
    );
  }
}
```
