import type {PlayerRef} from "@remotion/player";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import type {EditorAudioPlanView} from "../audio/audioPlanView.ts";
import {
  frameFromPointer,
  playheadPercent,
  sceneBlocks,
  seekTarget,
  timelineLabel,
  timelinePlaceholders,
  type TimelineLane,
} from "../audio/audioTimeline.ts";
import {
  drawEffectsLane,
  drawMusicLane,
  type LaneContext,
} from "../audio/drawTimelineLane.ts";
import type {StoryWaveforms} from "../audio/storyWaveforms.ts";

const MUSIC_LANE_HEIGHT = 48;
const EFFECTS_LANE_HEIGHT = 64;

/** The width of an element in CSS pixels, kept current while it is resized. */
const useElementWidth = (ref: RefObject<HTMLElement | null>): number => {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;

    if (element === null) {
      return;
    }

    setWidth(Math.floor(element.getBoundingClientRect().width));

    const observer = new ResizeObserver((entries) => {
      setWidth(Math.floor(entries[0]?.contentRect.width ?? 0));
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, [ref]);

  return width;
};

type LaneCanvasProps = {
  lane: TimelineLane;
  view: EditorAudioPlanView;
  waveforms: StoryWaveforms;
  width: number;
  height: number;
};

/**
 * One canvas per lane. It is redrawn when the Story, the plan, the waveforms or
 * the width change, never per Player frame (only the playhead moves).
 */
const LaneCanvas = ({lane, view, waveforms, width, height}: LaneCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (canvas === null || context === null || context === undefined || width < 1) {
      return;
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    (lane === "music" ? drawMusicLane : drawEffectsLane)(
      context as unknown as LaneContext,
      {view, waveforms, width, height},
    );
  }, [lane, view, waveforms, width, height, ratio]);

  return (
    <canvas
      ref={canvasRef}
      className="timeline-canvas"
      width={Math.max(1, Math.round(width * ratio))}
      height={Math.max(1, Math.round(height * ratio))}
      style={{width, height}}
      aria-hidden="true"
      data-timeline-canvas={lane}
    />
  );
};

type LanesProps = {view: EditorAudioPlanView; waveforms: StoryWaveforms};

/** Everything that does not change per Player frame: scene blocks, both lanes and the placeholder blocks. */
const TimelineLanes = memo(({view, waveforms}: LanesProps) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(surfaceRef);
  const placeholders = timelinePlaceholders(view);

  return (
    <div className="timeline-lanes" ref={surfaceRef}>
      <div className="timeline-scenes">
        {sceneBlocks(view.timeline).map((block) => (
          <div
            key={block.index}
            className="timeline-scene"
            style={{left: `${block.leftPct}%`, width: `${block.widthPct}%`}}
            data-timeline-scene={block.number}
          >
            <span>{block.number}</span>
          </div>
        ))}
      </div>
      {(["music", "effects"] as const).map((lane) => {
        const height = lane === "music" ? MUSIC_LANE_HEIGHT : EFFECTS_LANE_HEIGHT;

        return (
          <div
            key={lane}
            className={`timeline-lane timeline-lane-${lane}`}
            style={{height}}
            data-timeline-lane={lane}
          >
            <LaneCanvas
              lane={lane}
              view={view}
              waveforms={waveforms}
              width={width}
              height={height}
            />
            {placeholders
              .filter((block) => block.lane === lane)
              .map((block) => (
                <div
                  key={block.key}
                  className={`timeline-block timeline-block-${block.appearance} timeline-band-${block.band}`}
                  style={{left: `${block.leftPct}%`, width: `${block.widthPct}%`}}
                  data-timeline-placeholder={block.appearance}
                  data-timeline-role={block.role}
                >
                  <span>{block.label}</span>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
});

TimelineLanes.displayName = "TimelineLanes";

type AudioTimelineProps = {
  view: EditorAudioPlanView;
  waveforms: StoryWaveforms;
  playerRef: RefObject<PlayerRef | null>;
};

/**
 * The read-only audio timeline under the Player: scene blocks, a music lane
 * and an effects/voice lane, a playhead synced to the Player and one focusable
 * element that seeks (click or tap, Left and Right arrows between scene
 * starts, Home and End).
 */
export const AudioTimeline = ({view, waveforms, playerRef}: AudioTimelineProps) => {
  const [frame, setFrame] = useState(0);
  const total = view.timeline.durationInFrames;
  const shown = Math.min(frame, Math.max(0, total - 1));

  useEffect(() => {
    const player = playerRef.current;

    if (player === null) {
      return;
    }

    setFrame(player.getCurrentFrame());

    const onFrame = ({detail}: {detail: {frame: number}}) => setFrame(detail.frame);

    player.addEventListener("frameupdate", onFrame);

    return () => player.removeEventListener("frameupdate", onFrame);
  }, [playerRef]);

  const seek = (target: number) => {
    playerRef.current?.seekTo(target);
    setFrame(target);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = seekTarget(event.key, shown, view.timeline);

    if (target !== null) {
      event.preventDefault();
      seek(target);
    }
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();

    seek(frameFromPointer(event.clientX - rect.left, rect.width, total));
  };

  return (
    <div
      className="audio-timeline"
      tabIndex={0}
      role="slider"
      aria-label={timelineLabel(shown, view.timeline, view.fps)}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, total - 1)}
      aria-valuenow={shown}
      data-audio-timeline=""
      data-audio-tracks={view.plan.tracks.map((track) => track.key).join(" ")}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      <TimelineLanes view={view} waveforms={waveforms} />
      <div
        className="timeline-playhead"
        style={{left: `${playheadPercent(shown, total)}%`}}
        aria-hidden="true"
        data-timeline-playhead=""
      />
    </div>
  );
};
