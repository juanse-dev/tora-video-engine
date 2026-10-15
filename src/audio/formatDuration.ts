/** "m:ss" for a card: whole seconds, at least 0:01 for any positive duration, 0:00 for bad input. */
export const formatAudioDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const total = Math.max(1, Math.round(seconds));

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
