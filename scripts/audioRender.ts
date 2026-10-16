// CLI audio for `npm run video` (AUDIO-005): stages the bundled files next to the
// staged local ones, measures every staged file, refuses to render while any
// audio source is missing (AINV-5), and decodes every staged file once with
// ffmpeg before Remotion is spawned (AINV-8).
//
// Remotion reads only the staged copies under `__local-assets/`: a change to
// `public/audio/` or to `local-assets/audio/` after staging cannot reach the render.

import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {dirname, extname, join} from "node:path";
import {
  bundledAudioCatalog,
  isBundledAudio,
  type AudioDurationMap,
  type AudioRef,
  type BundledAudio,
} from "../src/audio/catalog.ts";
import {MAX_AUDIO_STORY_SECONDS} from "../src/audio/constants.ts";
import {compileAudioPlan} from "../src/audio/plan.ts";
import {
  audioFileUnusableMessage,
  bundledAudioMismatchMessage,
  bundledAudioUnavailableMessage,
  describeAudioRefRoles,
  describeAudioRole,
} from "../src/audio/readiness.ts";
import {
  audioSourceState,
  buildAudioSourceMap,
  resolveAudioSrc,
  type AudioSource,
  type AudioSourceMap,
} from "../src/audio/sources.ts";
import {storyAudioDurations, storyAudioRefs} from "../src/audio/storyAudio.ts";
import {inspectAudio} from "../src/localAssets/audioInspection.ts";
import {isLocalAudioRef} from "../src/localAssets/refs.ts";
import {
  STAGED_LOCAL_ASSETS_DIR,
  type LocalAssetSourceMap,
} from "../src/localAssets/sources.ts";
import {compileTimeline} from "../src/story/timeline.ts";
import type {Story} from "../src/story/types.ts";
import {VIDEO_FPS} from "../src/videoConfig.ts";
import {checkAudioFileDecodes, type AudioPreflightDeps} from "./audioPreflight.ts";

/** A bundled file must be as long as its catalog says (D-8), within this much. */
const BUNDLED_DURATION_TOLERANCE_SECONDS = 0.001;

/** The staged bundled copies live in their own folder next to `audio/` (staged local files). */
export const STAGED_BUNDLED_AUDIO_DIR = `${STAGED_LOCAL_ASSETS_DIR}/bundled`;

/** The render cannot start because of its audio; the message says why and for which role. */
export class AudioRenderError extends Error {
  override name = "AudioRenderError";
}

export type CliAudioOptions = {
  /** The command's private public directory (a copy of `public/`; staged files are added to it). */
  publicDir: string;
  /** `stageLocalAssetsForStory(...).sources`: the static paths of the staged local files. */
  localSources: LocalAssetSourceMap;
  /** What a person calls a staged local file (its path in `local-assets/audio/`), by ref. */
  localNames?: ReadonlyMap<string, string>;
  /** Where the bundled files are read from. Defaults to the repository `public/`. */
  publicSourceDir?: string;
  /** Called between files so an interrupt stops the work early. */
  checkInterrupt?: () => void;
  /** The command's interrupt guard: the decode children are attached to it, so a signal stops them. */
  control?: AudioPreflightDeps["control"];
  preflight?: AudioPreflightDeps;
};

export type CliAudioInputs = {
  audioDurations: AudioDurationMap;
  audioSources: AudioSourceMap;
};

type StagedAudio = {
  ref: AudioRef;
  /** What the error messages call the file. */
  name: string;
  /** Absolute path of the staged copy. */
  path: string;
};

const unusable = (
  name: string,
  roles: readonly string[],
  reason: string,
): AudioRenderError =>
  new AudioRenderError(
    [
      audioFileUnusableMessage(name),
      `  used by: ${roles.join(", ")}`,
      `  reason: ${reason}`,
    ].join("\n"),
  );

const readableFile = async (path: string): Promise<Uint8Array | null> => {
  try {
    if (!(await stat(path)).isFile()) {
      return null;
    }

    return await readFile(path);
  } catch {
    return null;
  }
};

/** Copies the bundled file of `id` into the staging directory; null when this build has no such file. */
const stageBundledFile = async (
  id: BundledAudio,
  options: {publicDir: string; publicSourceDir: string},
): Promise<{source: AudioSource; staged: string | null}> => {
  const {file} = bundledAudioCatalog[id];

  if (file === null) {
    return {source: {kind: "unavailable"}, staged: null};
  }

  const bytes = await readableFile(join(options.publicSourceDir, ...file.split("/")));

  if (bytes === null) {
    return {source: {kind: "unavailable"}, staged: null};
  }

  const stagedPath = `${STAGED_BUNDLED_AUDIO_DIR}/${id}${extname(file)}`;
  const absolute = join(options.publicDir, ...stagedPath.split("/"));

  await mkdir(dirname(absolute), {recursive: true});
  await writeFile(absolute, bytes);

  return {source: {kind: "static", path: stagedPath}, staged: absolute};
};

const planProblems = (story: Story, audioDurations: AudioDurationMap, audioSources: AudioSourceMap): string[] => {
  const plan = compileAudioPlan({
    story,
    timeline: compileTimeline(story, VIDEO_FPS, audioDurations),
    fps: VIDEO_FPS,
    audioDurations,
    sourceState: (ref) =>
      audioSourceState(resolveAudioSrc(ref, audioSources, "explicit")),
  });
  const problems: string[] = [];

  for (const issue of plan.issues) {
    if (issue.kind === "missing-audio") {
      problems.push(
        `  ${describeAudioRole(issue.role, issue.sceneIndex)}: ${
          isBundledAudio(issue.ref)
            ? bundledAudioUnavailableMessage(issue.ref)
            : `Audio file ${issue.ref} is missing.`
        }`,
      );
    } else if (issue.kind === "pending-audio") {
      // Staged sources are never pending: this is a bug, not a user error.
      problems.push(
        `  ${describeAudioRole(issue.role, issue.sceneIndex)}: internal error, the source of ${issue.ref} is still pending.`,
      );
    } else if (issue.kind === "story-too-long-for-audio") {
      problems.push(
        `  This Story is longer than ${MAX_AUDIO_STORY_SECONDS} s, the limit for Stories with audio.`,
      );
    }
  }

  return problems;
};

/**
 * Everything the render of a Story with audio needs before Remotion starts:
 * the props' `audioDurations` and `audioSources`. Throws `AudioRenderError`
 * (and leaves nothing for Remotion to read) when any audio source is missing
 * or fails the metadata or decode checks.
 */
export const prepareCliAudio = async (
  story: Story,
  options: CliAudioOptions,
): Promise<CliAudioInputs> => {
  const checkInterrupt = options.checkInterrupt ?? (() => undefined);
  const publicSourceDir = options.publicSourceDir ?? "public";
  const refs = storyAudioRefs(story);
  const staged: StagedAudio[] = [];
  const bundledSources: Partial<Record<BundledAudio, AudioSource>> = {};

  // 1. Bundled files are staged before anything is inspected.
  for (const ref of refs) {
    if (!isBundledAudio(ref)) {
      continue;
    }

    checkInterrupt();

    const result = await stageBundledFile(ref, {
      publicDir: options.publicDir,
      publicSourceDir,
    });

    bundledSources[ref] = result.source;

    if (result.staged !== null) {
      staged.push({ref, name: ref, path: result.staged});
    }
  }

  // The staged local copies were written by stageLocalAssetsForStory.
  for (const ref of refs) {
    const source = isLocalAudioRef(ref) ? options.localSources[ref] : undefined;

    if (source?.kind === "static") {
      staged.push({
        ref,
        name: options.localNames?.get(ref) ?? ref,
        path: join(options.publicDir, ...source.path.split("/")),
      });
    }
  }

  // 2. Metadata of every staged file (AINV-7); a local file's duration is the
  // one the timeline uses (AINV-3), a bundled file must match its catalog entry.
  const localDurations: Partial<Record<AudioRef, number>> = {};
  const durationOf = new Map<AudioRef, number>();

  for (const file of staged) {
    checkInterrupt();

    const bytes = await readableFile(file.path);
    const roles = describeAudioRefRoles(story, file.ref);

    if (bytes === null) {
      throw unusable(file.name, roles, "the staged copy could not be read");
    }

    const inspected = await inspectAudio(bytes);

    if (!inspected.ok) {
      throw unusable(file.name, roles, inspected.message);
    }

    const seconds = inspected.metadata.durationSeconds;

    if (isBundledAudio(file.ref)) {
      const expected = bundledAudioCatalog[file.ref].durationSeconds;

      if (
        expected === null ||
        Math.abs(seconds - expected) > BUNDLED_DURATION_TOLERANCE_SECONDS
      ) {
        throw new AudioRenderError(bundledAudioMismatchMessage(file.ref));
      }
    } else {
      localDurations[file.ref] = seconds;
    }

    durationOf.set(file.ref, seconds);
  }

  // 3. The plan with the very sources the render will read.
  const audioDurations = storyAudioDurations(story, localDurations);
  const audioSources = buildAudioSourceMap(
    story,
    options.localSources,
    (id) => bundledSources[id],
  );
  const problems = planProblems(story, audioDurations, audioSources);

  if (problems.length > 0) {
    throw new AudioRenderError(
      ["Cannot render Story: some of its audio is not available.", "", ...problems].join(
        "\n",
      ),
    );
  }

  // 4. One decode of every staged file, one at a time (AINV-8).
  for (const file of staged) {
    checkInterrupt();

    const seconds = durationOf.get(file.ref) as number;
    const decoded = await checkAudioFileDecodes(file.path, seconds, {
      ...options.preflight,
      ...(options.control === undefined ? {} : {control: options.control}),
    });

    if (!decoded.ok) {
      // A decode that was stopped by Ctrl+C is an interrupt, not an unusable file.
      checkInterrupt();
      throw unusable(
        file.name,
        describeAudioRefRoles(story, file.ref),
        decoded.detail,
      );
    }
  }

  return {audioDurations, audioSources};
};
