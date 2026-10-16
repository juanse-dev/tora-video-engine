import {Player, type PlayerRef} from "@remotion/player";
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import type {AudioDurationMap} from "../../audio/catalog.ts";
import type {AudioSourceMap} from "../../audio/sources.ts";
import {storyHasAudio} from "../../audio/storyAudio.ts";
import type {LocalAssetSourceMap} from "../../localAssets/sources.ts";
import {ToraVideo} from "../../Video.tsx";
import {exampleStory} from "../../story/exampleStory.ts";
import type {Story} from "../../story/types.ts";
import type {StoryLocalAssetState} from "../localAssetState.ts";
import {describeLocalAssetPreviewStatus} from "../localAssetPreviewStatus.ts";
import {applyArmingAction, nextArmingAction} from "../audioArming.ts";
import {audioPreview} from "../audio/previewPlayback.ts";
import {readStoredPlayerVolume, storePlayerVolume} from "../playerVolume.ts";
import {getWebPlayerConfig} from "../previewConfig.ts";

type PreviewProps = {
  story?: Story;
  localAssetSources?: LocalAssetSourceMap;
  localAssetState?: StoryLocalAssetState;
  audioDurations: AudioDurationMap;
  /**
   * The Player's audio sources, assembled once by App: the verified local audio
   * entries plus one entry per bundled id from the page's bundled-audio store.
   * The Player mounts a bundled sound only from its checked blob: URL.
   */
  audioSources: AudioSourceMap;
};

export const Preview = ({
  story = exampleStory,
  localAssetSources,
  localAssetState,
  audioDurations,
  audioSources,
}: PreviewProps) => {
  const config = getWebPlayerConfig(story, audioDurations);
  const playerRef = useRef<PlayerRef>(null);
  const frameProbeRef = useRef<HTMLDivElement>(null);
  const overBudget = localAssetState?.kind === "over-budget";
  const hasAudio = storyHasAudio(story);
  // The Player starts muted and a Story's tracks only mount after the Player
  // muted itself, so `armed` flips in a layout effect (see below).
  const [armed, setArmed] = useState(false);
  const audioArmed = hasAudio && armed;
  // Re-read whenever the Player (re)mounts: an over-budget Story unmounts it,
  // and the new Player must start at the volume the user last chose.
  const initialVolume = useMemo(
    () => readStoredPlayerVolume() ?? 1,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overBudget],
  );
  const inputProps = useMemo(
    () => ({
      story,
      localAssetSources,
      audioDurations,
      audioSources,
      bundledAudioPolicy: "explicit" as const,
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
    // The Player and a My audio preview never sound together: starting either
    // stops the other (the preview pauses the Player it is handed here).
    const onPlay = () => audioPreview().playerStarted();

    if (frameProbeRef.current !== null) {
      frameProbeRef.current.dataset.toraMuted = String(player.isMuted());
    }

    player.addEventListener("frameupdate", onFrameUpdate);
    player.addEventListener("mutechange", onMuteChange);
    player.addEventListener("volumechange", onVolumeChange);
    player.addEventListener("play", onPlay);
    audioPreview().setPlayerPause(() => player.pause());

    return () => {
      audioPreview().setPlayerPause(null);
      player.removeEventListener("play", onPlay);
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
