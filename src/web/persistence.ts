import {StorySchema, type Story} from "../story/schema.ts";
import {serializeStorySource} from "../story/serializeStory.ts";
import {
  MAX_BROWSER_TITLE_CODE_UNITS,
  MAX_BROWSER_ACTIVE_SCENES,
  MAX_VISUAL_CAPTION_CODE_UNITS,
  evaluateBrowserStoryPolicy,
  type BrowserStoryPolicyResult,
} from "./browserPolicy.ts";

export const PERSISTENCE_STORAGE_KEY = "tora-video-engine:project";
export const PERSISTENCE_WRITER_LOCK =
  "tora-video-engine:persistence-writer";
export const PERSISTENCE_VERSION = 1;
export const MAX_PERSISTED_ENVELOPE_CODE_UNITS = 1_048_576;

export type PersistedEnvelope = {
  version: typeof PERSISTENCE_VERSION;
  story: Story;
};

export type RawRecoveryKind =
  | "oversized"
  | "malformed"
  | "unsupported-version"
  | "preflight-rejected"
  | "schema-invalid";

export type ProtectedRecovery =
  | {
      kind: "raw";
      reason: RawRecoveryKind;
      raw: string;
      message: string;
    }
  | {
      kind: "policy-rejected";
      story: Story;
      policy: Extract<BrowserStoryPolicyResult, {eligible: false}>;
      message: string;
    };

export type RestoreResult = {
  activeStory: Story;
  restored: boolean;
  recovery: ProtectedRecovery | null;
  durableStory: Story | null;
  storageWarning: string | null;
};

export type RestoreDependencies = {
  jsonParse?: (raw: string) => unknown;
  storyParse?: (candidate: unknown) => ReturnType<typeof StorySchema.safeParse>;
  policy?: (story: Story) => BrowserStoryPolicyResult;
};

const rawRecovery = (
  activeStory: Story,
  raw: string,
  reason: RawRecoveryKind,
  message: string,
): RestoreResult => ({
  activeStory,
  restored: false,
  recovery: {kind: "raw", reason, raw, message},
  durableStory: null,
  storageWarning: null,
});

export const passesPersistedStoryPreflight = (
  candidate: unknown,
): boolean => {
  if (typeof candidate !== "object" || candidate === null) {
    return true;
  }

  const record = candidate as Record<string, unknown>;

  if (
    typeof record.title === "string" &&
    record.title.length > MAX_BROWSER_TITLE_CODE_UNITS
  ) {
    return false;
  }

  if (Array.isArray(record.scenes)) {
    if (record.scenes.length > MAX_BROWSER_ACTIVE_SCENES) {
      return false;
    }

    for (const scene of record.scenes) {
      if (
        typeof scene === "object" &&
        scene !== null &&
        typeof (scene as Record<string, unknown>).text === "string" &&
        ((scene as Record<string, unknown>).text as string).length >
          MAX_VISUAL_CAPTION_CODE_UNITS
      ) {
        return false;
      }
    }
  }

  return true;
};

export const restorePersistedProject = (
  raw: string | null,
  fallback: Story,
  dependencies: RestoreDependencies = {},
): RestoreResult => {
  if (raw === null) {
    return {
      activeStory: fallback,
      restored: false,
      recovery: null,
      durableStory: null,
      storageWarning: null,
    };
  }

  if (raw.length > MAX_PERSISTED_ENVELOPE_CODE_UNITS) {
    return rawRecovery(
      fallback,
      raw,
      "oversized",
      "Stored project exceeds the safe envelope limit.",
    );
  }

  const jsonParse = dependencies.jsonParse ?? JSON.parse;
  let parsed: unknown;

  try {
    parsed = jsonParse(raw);
  } catch {
    return rawRecovery(
      fallback,
      raw,
      "malformed",
      "Stored project is malformed and was preserved for recovery.",
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    return rawRecovery(
      fallback,
      raw,
      "unsupported-version",
      "Stored project has an unsupported persistence format.",
    );
  }

  const envelope = parsed as Record<string, unknown>;

  if (envelope.version !== PERSISTENCE_VERSION) {
    return rawRecovery(
      fallback,
      raw,
      "unsupported-version",
      "Stored project uses an unsupported persistence version.",
    );
  }

  if (!passesPersistedStoryPreflight(envelope.story)) {
    return rawRecovery(
      fallback,
      raw,
      "preflight-rejected",
      "Stored project exceeds browser preflight limits.",
    );
  }

  const storyParse =
    dependencies.storyParse ??
    ((candidate: unknown) => StorySchema.safeParse(candidate));
  const parsedStory = storyParse(envelope.story);

  if (!parsedStory.success) {
    return rawRecovery(
      fallback,
      raw,
      "schema-invalid",
      "Stored project does not match the Story schema.",
    );
  }

  const policy = dependencies.policy ?? evaluateBrowserStoryPolicy;
  const policyResult = policy(parsedStory.data);

  if (!policyResult.eligible) {
    return {
      activeStory: fallback,
      restored: false,
      recovery: {
        kind: "policy-rejected",
        story: parsedStory.data,
        policy: policyResult,
        message:
          "Stored Story is valid for the engine but exceeds browser authoring limits.",
      },
      durableStory: null,
      storageWarning: null,
    };
  }

  return {
    activeStory: parsedStory.data,
    restored: true,
    recovery: null,
    durableStory: parsedStory.data,
    storageWarning: null,
  };
};

export const serializePersistedEnvelope = (
  story: Story,
): string => {
  const envelope: PersistedEnvelope = {
    version: PERSISTENCE_VERSION,
    story,
  };
  const serialized = JSON.stringify(envelope);

  if (serialized.length > MAX_PERSISTED_ENVELOPE_CODE_UNITS) {
    throw new Error(
      "Persisted project exceeds the safe storage-envelope limit.",
    );
  }

  return serialized;
};

export const storiesSemanticallyEqual = (
  left: Story | null,
  right: Story,
): boolean =>
  left !== null &&
  serializeStorySource(left) === serializeStorySource(right);

export type PersistenceOwnership =
  | {mode: "owner"; release: () => void}
  | {mode: "secondary"}
  | {mode: "session-only"};

export const acquirePersistenceOwnership = async (
  locks: LockManager | undefined,
): Promise<PersistenceOwnership> => {
  if (locks === undefined) {
    return {mode: "session-only"};
  }

  let releaseHold: (() => void) | null = null;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  let acquisitionFailed = false;
  let resolveAcquired: ((owned: boolean) => void) | null = null;
  const acquired = new Promise<boolean>((resolve) => {
    resolveAcquired = resolve;
  });

  void locks
    .request(
      PERSISTENCE_WRITER_LOCK,
      {mode: "exclusive", ifAvailable: true},
      async (lock: Lock | null) => {
        resolveAcquired?.(lock !== null);

        if (lock !== null) {
          await hold;
        }
      },
    )
    .catch(() => {
      acquisitionFailed = true;
      resolveAcquired?.(false);
    });

  const owned = await acquired;

  if (!owned) {
    return acquisitionFailed
      ? {mode: "session-only"}
      : {mode: "secondary"};
  }

  return {
    mode: "owner",
    release: () => {
      releaseHold?.();
      releaseHold = null;
    },
  };
};
