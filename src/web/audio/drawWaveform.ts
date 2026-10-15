/** The few canvas members the drawing needs (a recording fake in Node tests). */
export type WaveformContext = {
  clearRect: (x: number, y: number, width: number, height: number) => void;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  fillStyle: string | CanvasGradient | CanvasPattern;
};

/**
 * Draws `columns` (values in [0, 1]) as mirrored bars around the middle of a
 * `width` x `height` area. A silent column draws nothing; any sound is at least
 * one pixel tall so a quiet passage stays visible.
 */
export const drawWaveformBars = (
  context: WaveformContext,
  columns: Float32Array,
  area: {x?: number; y?: number; width: number; height: number},
  color: string,
): void => {
  const {x = 0, y = 0, width, height} = area;

  if (columns.length === 0 || width <= 0 || height <= 0) {
    return;
  }

  const barWidth = width / columns.length;

  context.fillStyle = color;

  for (let index = 0; index < columns.length; index += 1) {
    const level = Math.min(1, Math.max(0, columns[index]));

    if (level > 0) {
      const barHeight = Math.max(1, level * height);

      context.fillRect(
        x + index * barWidth,
        y + (height - barHeight) / 2,
        Math.max(1, barWidth - 0.5),
        barHeight,
      );
    }
  }
};
