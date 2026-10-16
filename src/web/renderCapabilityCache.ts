import {
  describeCapabilityProbeFailure,
  type BrowserRenderCapability,
} from "./browserRender.ts";

export type RenderCapabilityCache = {
  /**
   * The capability for a Story with (`true`) or without (`false`) audio. The
   * probe for each value runs at most once; the other value is never probed
   * until a Story needs it, so a silent Story never pays for the audio probe.
   */
  get(hasAudio: boolean): Promise<BrowserRenderCapability>;
  /** Whether the probe for this value was started. */
  started(hasAudio: boolean): boolean;
};

/** A probe that fails is the same "unsupported" the transaction's own check reports, never a throw. */
const probe = async (
  check: (options: {hasAudio: boolean}) => Promise<BrowserRenderCapability>,
  hasAudio: boolean,
): Promise<BrowserRenderCapability> => {
  try {
    return await check({hasAudio});
  } catch (error) {
    return {
      kind: "unsupported",
      message: describeCapabilityProbeFailure(error, hasAudio),
    };
  }
};

export const createRenderCapabilityCache = (
  check: (options: {hasAudio: boolean}) => Promise<BrowserRenderCapability>,
): RenderCapabilityCache => {
  const entries = new Map<boolean, Promise<BrowserRenderCapability>>();

  return {
    get(hasAudio) {
      let entry = entries.get(hasAudio);

      if (entry === undefined) {
        entry = probe(check, hasAudio);
        entries.set(hasAudio, entry);
      }

      return entry;
    },
    started: (hasAudio) => entries.has(hasAudio),
  };
};
