import {useEffect, useRef} from "react";
import {drawWaveformBars} from "../audio/drawWaveform.ts";
import {waveformColumns, type WaveformPeaks} from "../audio/waveformColumns.ts";

type WaveformCanvasProps = {
  waveform: WaveformPeaks;
  /** How many seconds of the sound the canvas shows. */
  seconds: number;
  className?: string;
};

const WIDTH = 240;
const HEIGHT = 48;
const COLUMNS = 120;

/** A My audio card's waveform thumbnail, drawn once from the stored peaks. Decorative. */
export const WaveformCanvas = ({waveform, seconds, className}: WaveformCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");

    if (context === null || context === undefined) {
      return;
    }

    context.clearRect(0, 0, WIDTH, HEIGHT);
    drawWaveformBars(
      context,
      waveformColumns(waveform, seconds, COLUMNS),
      {width: WIDTH, height: HEIGHT},
      "#94a3b8",
    );
  }, [waveform, seconds]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={WIDTH}
      height={HEIGHT}
      aria-hidden="true"
      data-waveform-thumbnail=""
    />
  );
};
