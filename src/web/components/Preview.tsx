import {Player, type PlayerRef} from "@remotion/player";
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import {buildAudioSourceMap} from "../../audio/sources.ts";
import {storyAudioDurations, storyHasAudio} from "../../audio/storyAudio.ts";
import type {LocalAssetSourceMap} from "../../localAssets/sources.ts";
import {ToraVideo} from "../../Video.tsx";
import {exampleStory} from "../../story/exampleStory.ts";
import type {Story} from "../../story/types.ts";
import type {StoryLocalAssetState} from "../localAssetState.ts";
import {applyArmingAction, nextArmingAction} from "../audioArming.ts";
import {readStoredPlayerVolume, storePlayerVolume} from "../playerVolume.ts";
import {getWebPlayerConfig} from "../previewConfig.ts";

// Until the bundled-audio store exists (AUDIO-004) no bundled sound has an
// entry, and the Player resolves bundled ids with "static-fallback".
const noBundledAudio = () => undefined;

type PreviewProps = {
  story?: Story;
  localAssetSources?: LocalAssetSourceMap;
  localAssetState?: StoryLocalAssetState;
};

/**
 * Short status line for refs that are not ready, e.g.
 * "2 local assets are missing in this browser. Scenes 1, 3 show placeholders."
 * Returns null when every ref is ready (or there is nothing to report yet).
 */
export const describeLocalAssetPreviewStatus = (
  state: StoryLocalAssetState | undefined,
): string | null => {
  if (state?.kind !== "resolved") {
    return null;
  }

  const notReady = state.refs.filter((entry) => entry.status !== "ready");

  if (notReady.length === 0) {
    return null;
  }

  // Corrupt is shown like missing (D-9); only "unavailable" gets its own word.
  const word = notReady.some((entry) => entry.status !== "unavailable")
    ? "missing"
    : "unavailable";
  const scenes = [
    ...new Set(notReady.flatMap((entry) => entry.usage.sceneIndexes)),
  ]
    .sort((a, b) => a - b)
    .map((index) => index + 1);
  const count = notReady.length;
  const sentences = [
    `${count} local ${count === 1 ? "asset is" : "assets are"} ${word} in this browser.`,
    scenes.length === 1
      ? `Scene ${scenes[0]} shows a placeholder.`
      : `Scenes ${scenes.join(", ")} show placeholders.`,
  ];
  const details = [
    ...new Set(
      [
        state.failureMessage,
        ...notReady
          .filter((entry) => entry.status === "unavailable")
          .map((entry) => entry.detail),
      ].filter((detail): detail is string => detail !== null && detail !== ""),
    ),
  ];

  return [...sentences, ...details].join(" ");
};

export const Preview = ({
  story = exampleStory,
  localAssetSources,
  localAssetState,
}: PreviewProps) => {
  const audioDurations = useMemo(() => storyAudioDurations(story), [story]);
  const config = getWebPlayerConfig(story, audioDurations);
  const playerRef = useRef<PlayerRef>(null);
  const frameProbeRef = useRef<HTMLDivElement>(null);
  const overBudget = localAssetState?.kind === "over-budget";
  const audioSources = useMemo(
    () => buildAudioSourceMap(story, localAssetSources, noBundledAudio),
    [story, localAssetSources],
  );
  const hasAudio = storyHasAudio(story);
  // The Player starts muted and a Story's tracks only mount after the Player
  // muted itself, so `armed` flips in a layout effect (see below).
  const [armed, setArmed] = useState(false);
  const audioArmed = hasAudio && armed;
  const [initialVolume] = useState(() => readStoredPlayerVolume() ?? 1);
  const inputProps = useMemo(
    () => ({
      story,
      localAssetSources,
      audioDurations,
      audioSources,
      bundledAudioPolicy: "static-fallback" as const,
      audioArmed,
    }),
    [story, localAssetSources, audioDurations, audioSources, audioArmed],
  );
  const statusLine = describeLocalAssetPreviewStatus(localAssetState);

  // Mute first, then arm: the first commit that mounts an <Audio> happens
  // after the Player is muted (layout effects and their updates finish
  // before paint, and the tracks did not exist before).
  useLayoutEffect(() => {
    applyArmingAction(
      nextArmingAction(hasAudio, armed),
      playerRef.current,
      setArmed,
    );
  }, [hasAudio, armed, overBudget]);

  useEffect(() => {
    const player = playerRef.current;

    if (player === null) {
      return;
    }

    const onFrameUpdate = ({detail}: {detail: {frame: number}}) => {
      if (frameProbeRef.current !== null) {
        frameProbeRef.current.dataset.toraFrame = String(detail.frame);
      }
    };
    const onMuteChange = ({detail}: {detail: {isMuted: boolean}}) => {
      if (frameProbeRef.current !== null) {
        frameProbeRef.current.dataset.toraMuted = String(detail.isMuted);
      }
    };
    const onVolumeChange = ({detail}: {detail: {volume: number}}) => {
      storePlayerVolume(detail.volume);
    };

    if (frameProbeRef.current !== null) {
      frameProbeRef.current.dataset.toraMuted = String(player.isMuted());
    }

    player.addEventListener("frameupdate", onFrameUpdate);
    player.addEventListener("mutechange", onMuteChange);
    player.addEventListener("volumechange", onVolumeChange);

    return () => {
      player.removeEventListener("frameupdate", onFrameUpdate);
      player.removeEventListener("mutechange", onMuteChange);
      player.removeEventListener("volumechange", onVolumeChange);
    };
  }, [overBudget]);

  if (localAssetState?.kind === "over-budget") {
    return (
      <div className="preview-frame">
        <div data-local-asset-over-budget role="status">
          {localAssetState.message}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={frameProbeRef}
      className="preview-frame"
      data-tora-frame="0"
      data-tora-audio-armed={String(audioArmed)}
    >
      <Player
        ref={playerRef}
        component={ToraVideo}
        inputProps={inputProps}
        durationInFrames={config.durationInFrames}
        fps={config.fps}
        compositionWidth={config.compositionWidth}
        compositionHeight={config.compositionHeight}
        controls
        // Always start muted: an unmuted Player whose AudioContext never
        // resumes stays at frame 0 (issue #24), so the user's unmute click
        // creates it. Volume controls exist only for Stories with audio; a
        // silent Story keeps the v0.3 Player.
        initiallyMuted
        initialVolume={initialVolume}
        showVolumeControls={hasAudio}
        errorFallback={({error}) => (
          <div data-preview-error role="alert">
            Preview unavailable: {error.message}
          </div>
        )}
        style={{
          width: "100%",
        }}
      />
      {statusLine !== null ? (
        <p data-local-asset-status>{statusLine}</p>
      ) : null}
    </div>
  );
};
