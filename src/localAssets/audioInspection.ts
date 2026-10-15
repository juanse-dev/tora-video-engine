import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  Input,
  MP3,
  MP4,
  OGG,
  WAVE,
} from "mediabunny";
import {
  AUDIO_TRUNCATION_TOLERANCE_SECONDS,
  MAX_AUDIO_CHANNELS,
  MAX_AUDIO_DURATION_SECONDS,
  MAX_AUDIO_SAMPLE_RATE,
  MAX_LOCAL_AUDIO_BYTES,
  MIN_AUDIO_SAMPLE_RATE,
} from "./limits.ts";

export type AudioContainer = "mp3" | "wave" | "mp4" | "ogg";
export type AudioCodec = "mp3" | "pcm" | "aac" | "opus" | "vorbis";

export type AudioMetadata = {
  container: AudioContainer;
  codec: AudioCodec;
  durationSeconds: number;
  sampleRate: number;
  channels: 1 | 2;
};

export type AudioInspection =
  | {ok: true; metadata: AudioMetadata}
  | {ok: false; message: string};

/** What a media reader reports, before any acceptance rule is applied. */
export type RawAudioInfo = {
  /** null: a container this feature does not accept (or not a media file at all). */
  container: AudioContainer | null;
  videoTrackCount: number;
  audioTracks: ReadonlyArray<{
    /** The reader's codec name ("mp3", "aac", "opus", "vorbis", "pcm-s16", "flac"...), or null. */
    codec: string | null;
    sampleRate: number;
    channels: number;
  }>;
  /** NaN when the reader did not compute it (an earlier rule already rejects the file). */
  durationSeconds: number;
};

export type ReadRawAudioInfo = (
  source: Blob | Uint8Array,
) => Promise<RawAudioInfo>;

const MIB = 1024 * 1024;

export const AUDIO_EMPTY_MESSAGE = "This audio file is empty.";
export const AUDIO_TOO_LARGE_MESSAGE = `This audio file is larger than ${MAX_LOCAL_AUDIO_BYTES / MIB} MiB.`;
export const AUDIO_UNSUPPORTED_MESSAGE =
  "This is not a supported audio file. Use MP3, WAV, M4A or Ogg Opus.";
export const AUDIO_VIDEO_MESSAGE =
  "Video files are not supported. Use an audio file.";
export const AUDIO_TRACKS_MESSAGE =
  "The file must contain exactly one audio track.";
export const AUDIO_CODEC_MESSAGE =
  "This audio codec is not supported. Use MP3, WAV, M4A or Ogg Opus.";
export const AUDIO_VORBIS_MESSAGE =
  "Ogg Vorbis audio is not supported. Use MP3, WAV, M4A or Ogg Opus.";
export const AUDIO_DURATION_UNKNOWN_MESSAGE =
  "The length of this audio file could not be read.";
export const AUDIO_TOO_LONG_MESSAGE = `Audio can be at most ${MAX_AUDIO_DURATION_SECONDS} seconds (${MAX_AUDIO_DURATION_SECONDS / 60} minutes) long.`;
export const AUDIO_SAMPLE_RATE_MESSAGE = `Audio sample rate must be between ${MIN_AUDIO_SAMPLE_RATE} and ${MAX_AUDIO_SAMPLE_RATE} Hz.`;
export const AUDIO_CHANNELS_MESSAGE = "Audio must be mono or stereo.";

export const audioContainers = ["mp3", "wave", "mp4", "ogg"] as const;
export const audioCodecs = ["mp3", "pcm", "aac", "opus", "vorbis"] as const;

const ACCEPTED_CODECS: Readonly<Record<AudioContainer, AudioCodec>> = {
  mp3: "mp3",
  wave: "pcm",
  mp4: "aac",
  ogg: "opus",
};

/** True for the (container, codec) pairs a Story may use: mp3/mp3, wave/pcm, mp4/aac, ogg/opus. */
export const isAcceptedAudioCombination = (
  container: AudioContainer,
  codec: AudioCodec,
): boolean => ACCEPTED_CODECS[container] === codec;

const AUDIO_MIME_TYPES = {
  mp3: "audio/mpeg",
  wave: "audio/wav",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
} as const satisfies Record<AudioContainer, string>;

export type AudioMimeType = (typeof AUDIO_MIME_TYPES)[AudioContainer];

/** The payload MIME type, chosen from the inspected container and never from the file's own type. */
export const audioMimeTypeFor = (container: AudioContainer): AudioMimeType =>
  AUDIO_MIME_TYPES[container];

const AUDIO_FILE_EXTENSIONS = {
  mp3: "mp3",
  wave: "wav",
  mp4: "m4a",
  ogg: "ogg",
} as const satisfies Record<AudioContainer, string>;

/** The extension of a staged copy, by inspected container. */
export const audioFileExtensionFor = (
  container: AudioContainer,
): (typeof AUDIO_FILE_EXTENSIONS)[AudioContainer] =>
  AUDIO_FILE_EXTENSIONS[container];

const toAudioCodec = (reported: string | null): AudioCodec | null => {
  if (reported === null) {
    return null;
  }

  if (reported.startsWith("pcm-")) {
    return "pcm";
  }

  return reported === "mp3" ||
    reported === "aac" ||
    reported === "opus" ||
    reported === "vorbis"
    ? reported
    : null;
};

const isIntegerInRange = (value: number, min: number, max: number): boolean =>
  Number.isFinite(value) &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

/**
 * Applies the acceptance rules, in the order the spec lists them, to what a
 * reader found. Pure: the byte-size rules run before any reader is called.
 */
export const evaluateRawAudioInfo = (info: RawAudioInfo): AudioInspection => {
  if (info.container === null) {
    return {ok: false, message: AUDIO_UNSUPPORTED_MESSAGE};
  }

  if (info.videoTrackCount > 0) {
    return {ok: false, message: AUDIO_VIDEO_MESSAGE};
  }

  if (info.audioTracks.length !== 1) {
    return {ok: false, message: AUDIO_TRACKS_MESSAGE};
  }

  const [track] = info.audioTracks;
  const codec = toAudioCodec(track.codec);

  if (info.container === "ogg" && codec === "vorbis") {
    return {ok: false, message: AUDIO_VORBIS_MESSAGE};
  }

  if (codec === null || !isAcceptedAudioCombination(info.container, codec)) {
    return {ok: false, message: AUDIO_CODEC_MESSAGE};
  }

  if (!Number.isFinite(info.durationSeconds) || info.durationSeconds <= 0) {
    return {ok: false, message: AUDIO_DURATION_UNKNOWN_MESSAGE};
  }

  if (info.durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
    return {ok: false, message: AUDIO_TOO_LONG_MESSAGE};
  }

  if (
    !isIntegerInRange(
      track.sampleRate,
      MIN_AUDIO_SAMPLE_RATE,
      MAX_AUDIO_SAMPLE_RATE,
    )
  ) {
    return {ok: false, message: AUDIO_SAMPLE_RATE_MESSAGE};
  }

  if (!isIntegerInRange(track.channels, 1, MAX_AUDIO_CHANNELS)) {
    return {ok: false, message: AUDIO_CHANNELS_MESSAGE};
  }

  return {
    ok: true,
    metadata: {
      container: info.container,
      codec,
      durationSeconds: info.durationSeconds,
      sampleRate: track.sampleRate,
      channels: track.channels as 1 | 2,
    },
  };
};

const UNRECOGNIZED: RawAudioInfo = {
  container: null,
  videoTrackCount: 0,
  audioTracks: [],
  durationSeconds: Number.NaN,
};

/**
 * The declared (metadata) duration, unless the file is demonstrably longer: a
 * stale Xing/Info header (a file extended after it was written) declares less
 * than the file holds. When the scanned end of the last packet exceeds the
 * declared duration by more than the truncation tolerance the file really is
 * that long, so the scanned value wins and the length limit sees it. Otherwise
 * (equal within tolerance, or shorter: a truncated file) the declared value
 * stays, which is what the decode-time truncation rule compares against. A
 * scan failure keeps the declared value.
 */
const declaredOrScannedDuration = async (input: Input): Promise<number> => {
  const declared = await input.getDurationFromMetadata();

  if (declared === null) {
    return input.computeDuration();
  }

  try {
    const scanned = await input.computeDuration();

    if (scanned > declared + AUDIO_TRUNCATION_TOLERANCE_SECONDS) {
      return scanned;
    }
  } catch {
    // Keep the declared duration.
  }

  return declared;
};

/**
 * Metadata only, no decoding (S-7): runs unchanged in Node and in the browser.
 * The duration is the one the container declares (AINV-3): the metadata
 * duration when the file has one (an MP3 with a Xing header, an MP4 or WAV
 * header), else the end of the last packet; a file longer than its header
 * declares reports its real length (see declaredOrScannedDuration). A truncated
 * MP3 with a Xing header therefore keeps its declared length, which is what the
 * truncation rule needs.
 * Any reader failure means "not a supported audio file".
 */
export const readAudioInfoWithMediabunny: ReadRawAudioInfo = async (source) => {
  const input = new Input({
    source:
      source instanceof Uint8Array
        ? new BufferSource(source)
        : new BlobSource(source),
    formats: ALL_FORMATS,
  });

  try {
    if (!(await input.canRead())) {
      return UNRECOGNIZED;
    }

    const format = await input.getFormat();
    const container: AudioContainer | null =
      format === MP3
        ? "mp3"
        : format === WAVE
          ? "wave"
          : format === MP4
            ? "mp4"
            : format === OGG
              ? "ogg"
              : null;

    if (container === null) {
      return UNRECOGNIZED;
    }

    const videoTracks = await input.getVideoTracks();
    const audioTracks = await input.getAudioTracks();
    const described = await Promise.all(
      audioTracks.map(async (track) => ({
        codec: await track.getCodec(),
        sampleRate: await track.getSampleRate(),
        channels: await track.getNumberOfChannels(),
      })),
    );
    let durationSeconds = Number.NaN;

    if (videoTracks.length === 0 && audioTracks.length === 1) {
      durationSeconds = await declaredOrScannedDuration(input);
    }

    return {
      container,
      videoTrackCount: videoTracks.length,
      audioTracks: described,
      durationSeconds,
    };
  } catch {
    return UNRECOGNIZED;
  } finally {
    input.dispose();
  }
};

/**
 * Reads the container metadata of an audio file and applies the acceptance
 * rules. `bytes` may be a Blob or File (read lazily) or a Uint8Array. Never
 * returns metadata outside the AudioMetadata type.
 */
export const inspectAudio = async (
  bytes: Blob | Uint8Array,
  deps: {readInfo?: ReadRawAudioInfo} = {},
): Promise<AudioInspection> => {
  const size = bytes instanceof Uint8Array ? bytes.byteLength : bytes.size;

  if (!(size > 0)) {
    return {ok: false, message: AUDIO_EMPTY_MESSAGE};
  }

  if (size > MAX_LOCAL_AUDIO_BYTES) {
    return {ok: false, message: AUDIO_TOO_LARGE_MESSAGE};
  }

  let info: RawAudioInfo;

  try {
    info = await (deps.readInfo ?? readAudioInfoWithMediabunny)(bytes);
  } catch {
    return {ok: false, message: AUDIO_UNSUPPORTED_MESSAGE};
  }

  return evaluateRawAudioInfo(info);
};
