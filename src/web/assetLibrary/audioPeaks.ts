import {ALL_FORMATS, AudioSampleSink, BlobSource, Input} from "mediabunny";
import {
  MAX_WAVEFORM_PEAKS,
  WAVEFORM_PEAKS_PER_SECOND,
} from "../../audio/constants.ts";
import type {AudioMetadata} from "../../localAssets/audioInspection.ts";

export type DecodedAudioSummary = {
  decodedSeconds: number;
  peaks: Uint8Array;
  peaksPerSecond: number;
};

/** The decoder could not read the file (unsupported codec in this browser, or a corrupt stream). */
export class AudioDecodeError extends Error {
  override name = "AudioDecodeError";
  cause?: unknown;

  constructor(message: string, options?: {cause?: unknown}) {
    super(message);

    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** `min(ceil(durationSeconds x WAVEFORM_PEAKS_PER_SECOND), MAX_WAVEFORM_PEAKS)`, at least 1. */
export const peakBucketCount = (durationSeconds: number): number =>
  Math.max(
    1,
    Math.min(
      Math.ceil(durationSeconds * WAVEFORM_PEAKS_PER_SECOND),
      MAX_WAVEFORM_PEAKS,
    ),
  );

/**
 * Streaming max-abs peaks. Buckets are laid over the container duration, so
 * `peaksPerSecond = buckets / durationSeconds` places every peak in time; a
 * frame is assigned by its timestamp and out-of-range frames clamp to the ends.
 */
export const createPeakAccumulator = (durationSeconds: number) => {
  const buckets = peakBucketCount(durationSeconds);
  const maxima = new Float32Array(buckets);
  let decodedFrames = 0;
  let decodedRate = 0;

  return {
    /** `planes[c][i]` is frame `i` of channel `c`; the first frame starts at `startSeconds`. */
    push(
      startSeconds: number,
      sampleRate: number,
      planes: readonly Float32Array[],
    ): void {
      const frames = planes[0]?.length ?? 0;
      const framesPerBucket = (durationSeconds * sampleRate) / buckets;
      const firstFrame = startSeconds * sampleRate;

      for (let index = 0; index < frames; index += 1) {
        const bucket = Math.min(
          buckets - 1,
          Math.max(0, Math.floor((firstFrame + index) / framesPerBucket)),
        );
        let peak = maxima[bucket];

        for (const plane of planes) {
          const magnitude = Math.abs(plane[index]);

          if (magnitude > peak) {
            peak = magnitude;
          }
        }

        maxima[bucket] = peak;
      }

      decodedFrames += frames;
      decodedRate = sampleRate;
    },

    finish(): DecodedAudioSummary {
      const peaks = new Uint8Array(buckets);

      for (let index = 0; index < buckets; index += 1) {
        peaks[index] = Math.min(255, Math.round(255 * maxima[index]));
      }

      return {
        decodedSeconds: decodedRate > 0 ? decodedFrames / decodedRate : 0,
        peaks,
        peaksPerSecond: buckets / durationSeconds,
      };
    },
  };
};

/**
 * Decodes the whole file once (mediabunny, WebCodecs in the browser) to compute
 * the waveform peaks and the decoded length. Throws AudioDecodeError when the
 * browser cannot decode the file, and rethrows an abort.
 */
export const decodeAudioPeaks = async (
  blob: Blob,
  metadata: AudioMetadata,
  deps: {signal?: AbortSignal} = {},
): Promise<DecodedAudioSummary> => {
  const input = new Input({source: new BlobSource(blob), formats: ALL_FORMATS});

  try {
    const track = await input.getPrimaryAudioTrack();

    if (track === null || !(await track.canDecode())) {
      throw new AudioDecodeError("This browser cannot decode this audio file.");
    }

    const accumulator = createPeakAccumulator(metadata.durationSeconds);
    const sink = new AudioSampleSink(track);

    for await (const sample of sink.samples()) {
      try {
        deps.signal?.throwIfAborted();

        const planes: Float32Array[] = [];

        for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
          const plane = new Float32Array(sample.numberOfFrames);

          sample.copyTo(plane, {planeIndex: channel, format: "f32-planar"});
          planes.push(plane);
        }

        accumulator.push(sample.timestamp, sample.sampleRate, planes);
      } finally {
        sample.close();
      }
    }

    return accumulator.finish();
  } catch (error) {
    if (deps.signal?.aborted === true || error instanceof AudioDecodeError) {
      throw error;
    }

    throw new AudioDecodeError("The audio file could not be decoded.", {
      cause: error,
    });
  } finally {
    input.dispose();
  }
};
