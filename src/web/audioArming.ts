export type ArmingAction = "arm" | "disarm" | "none";

/**
 * The tracks of a Story with audio are mounted only after the Player is
 * muted. "arm" is needed on the first render that has audio and after every
 * period without audio; editing a Story that stays audible changes nothing,
 * so a user who unmuted is not muted again.
 */
export const nextArmingAction = (
  hasAudio: boolean,
  armed: boolean,
): ArmingAction => {
  if (hasAudio) {
    return armed ? "none" : "arm";
  }

  return armed ? "disarm" : "none";
};

/**
 * Applies the action. Arming mutes the Player first and only then sets the
 * state that lets `StoryAudio` mount, so the first commit containing an
 * `<Audio>` happens after the Player is muted. Without a Player yet it does
 * nothing and returns false. The caller retries when the Player mounts again:
 * Preview's layout effect depends on `overBudget`, so it re-runs once an
 * over-budget Story that unmounted the Player is replaced by one that fits.
 */
export const applyArmingAction = (
  action: ArmingAction,
  player: {mute: () => void} | null,
  setArmed: (armed: boolean) => void,
): boolean => {
  if (action === "none") {
    return true;
  }

  if (action === "disarm") {
    setArmed(false);

    return true;
  }

  if (player === null) {
    return false;
  }

  player.mute();
  setArmed(true);

  return true;
};
