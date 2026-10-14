export type ClippingTrack = {
  fromFrame: number;
  durationInFrames: number;
  gainAt: (absoluteFrame: number) => number;
};

/**
 * The largest amplitude sum, over all frames, of every track that is mounted
 * on that frame (D-7). One pass over the frames where something sounds, with
 * a small active set, so a 108,000-frame Story costs one pass, not one per track.
 */
export const maxSimultaneousGain = (
  tracks: readonly ClippingTrack[],
): number => {
  const pending = [...tracks].sort((a, b) => a.fromFrame - b.fromFrame);
  let active: ClippingTrack[] = [];
  let next = 0;
  let frame = 0;
  let best = 0;

  while (next < pending.length || active.length > 0) {
    if (active.length === 0) {
      frame = Math.max(frame, pending[next].fromFrame);
    }

    while (next < pending.length && pending[next].fromFrame <= frame) {
      active.push(pending[next]);
      next += 1;
    }

    active = active.filter(
      (track) => frame < track.fromFrame + track.durationInFrames,
    );

    if (active.length > 0) {
      let sum = 0;

      for (const track of active) {
        sum += track.gainAt(frame);
      }

      best = Math.max(best, sum);
      frame += 1;
    }
  }

  return best;
};
