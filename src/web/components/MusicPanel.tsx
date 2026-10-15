import type {AudioRef} from "../../audio/catalog.ts";
import {
  MAX_FADE_SECONDS,
  DEFAULT_AUDIO_VOLUME,
  DEFAULT_MUSIC_DUCK,
} from "../../audio/constants.ts";
import type {Music} from "../../story/schema.ts";
import type {
  LibraryAudioChoices,
  MusicNumberField,
} from "../audio/audioFields.ts";
import {AudioSelect, NumberField, UnitSlider} from "./AudioControls.tsx";

type MusicPanelProps = {
  music: Music | undefined;
  library: LibraryAudioChoices;
  /** Field errors of the visual draft, keyed `music.fadeIn` and so on. */
  errors: Record<string, string>;
  onSourceChange: (src: AudioRef | null) => void;
  onNumberChange: (field: MusicNumberField, value: number) => void;
};

/** The Story-level music controls, above the scene list. */
export const MusicPanel = ({
  music,
  library,
  errors,
  onSourceChange,
  onNumberChange,
}: MusicPanelProps) => (
  <section className="music-panel" aria-label="Music" data-music-panel="">
    <AudioSelect
      label="Music"
      value={music?.src}
      library={library}
      onChange={onSourceChange}
    />

    {music === undefined ? null : (
      <div className="music-settings">
        <UnitSlider
          label="Music volume"
          caption="Volume"
          value={music.volume ?? DEFAULT_AUDIO_VOLUME}
          onChange={(value) => onNumberChange("volume", value)}
        />
        <UnitSlider
          label="Music ducking"
          caption="Ducking"
          value={music.duck ?? DEFAULT_MUSIC_DUCK}
          onChange={(value) => onNumberChange("duck", value)}
        />
        <NumberField
          label="Fade in (seconds)"
          value={music.fadeIn ?? 0}
          min={0}
          max={MAX_FADE_SECONDS}
          step={0.1}
          error={errors["music.fadeIn"]}
          onCommit={(value) => onNumberChange("fadeIn", value)}
        />
        <NumberField
          label="Fade out (seconds)"
          value={music.fadeOut ?? 0}
          min={0}
          max={MAX_FADE_SECONDS}
          step={0.1}
          error={errors["music.fadeOut"]}
          onCommit={(value) => onNumberChange("fadeOut", value)}
        />
      </div>
    )}
  </section>
);
