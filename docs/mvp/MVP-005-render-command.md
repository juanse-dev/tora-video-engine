# MVP-005 — Render command

## Goal

Provide the single developer workflow that defines the MVP:

~~~bash
npm run video -- stories/friday-deploy.yaml
~~~

The command must transform one YAML file into one MP4 without manual intermediate steps.

## Command behavior

Input:

~~~bash
npm run video -- path/to/story.yaml
~~~

Pipeline:

~~~text
story path
   ↓
loadStory()
   ↓
validate
   ↓
compile render props / metadata
   ↓
Remotion render
   ↓
output/<story-slug>.mp4
~~~

## Output naming

For the MVP, derive a stable filename from the input filename.

Examples:

~~~text
stories/friday-deploy.yaml → output/friday-deploy.mp4
stories/kubernetes.yaml    → output/kubernetes.mp4
~~~

Do not implement a general-purpose CLI parser unless it is necessary for this one command.

## Render script

Implement a small Node/TypeScript script, suggested path:

~~~text
scripts/render.ts
~~~

Responsibilities:

1. parse the positional story path;
2. verify the file can be read;
3. call \`loadStory()\`;
4. determine output path;
5. invoke the Remotion rendering API or CLI integration appropriate for the installed version;
6. return a non-zero process exit code on failure;
7. print the final output path on success.

Keep story parsing and validation in the domain layer rather than duplicating them in the script.

## Output directory

\`output/\` is generated content.

Add an appropriate ignore rule so rendered MP4 files are not committed by default.

A placeholder such as \`output/.gitkeep\` is optional.

## Error behavior

The command must fail clearly for:

- missing positional argument;
- nonexistent input file;
- malformed YAML;
- schema validation failure;
- render failure.

No invalid story should start a render.

## Acceptance criteria

- \`npm run video -- stories/friday-deploy.yaml\` exits successfully;
- it creates \`output/friday-deploy.mp4\`;
- the file is a playable vertical H.264 video;
- total video duration matches the compiled timeline;
- rerunning the same command overwrites or deterministically replaces the expected output rather than inventing random names;
- invalid input exits non-zero and does not produce a misleading successful artifact;
- the successful command prints the generated file path.

## Out of scope

- globally installed \`tora\` binary;
- flags such as \`--format\`, \`--fps\`, \`--codec\` or \`--output\`;
- batch rendering;
- cloud rendering;
- render queue;
- progress UI beyond what the chosen Remotion integration naturally exposes.

## Done when

A developer can go from a YAML story to its final MP4 with one repository command.
