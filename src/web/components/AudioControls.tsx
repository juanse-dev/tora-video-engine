import {memo, useEffect, useId, useMemo, useState} from "react";
import type {AudioRef} from "../../audio/catalog.ts";
import {
  NO_AUDIO_VALUE,
  audioSelectOptions,
  type AudioSelectGroups,
  type LibraryAudioChoices,
} from "../audio/audioFields.ts";

type AudioSelectProps = {
  /** Visible label and accessible name: "Music", "Sound effect", "Voice". */
  label: string;
  /** The Story's current ref for this field, if any. */
  value: string | undefined;
  library: LibraryAudioChoices;
  /** `null` is the None option. */
  onChange: (src: AudioRef | null) => void;
  /** The `<select>`'s DOM id (a notice's Retry button moves focus back to it). */
  id?: string;
  /** The id of the element that describes this field (its warnings). */
  describedBy?: string;
};

/**
 * The options of one select. The element is memoized on `groups`, which is
 * itself memoized on (rows, settled, value): a re-render of the editor (every
 * keystroke in a caption) hands React the same element, so a library of
 * hundreds of sounds is not diffed again.
 */
const SelectOptions = memo(({groups}: {groups: AudioSelectGroups}) => (
  <>
    <option value={NO_AUDIO_VALUE}>None</option>
    {groups.bundled.length > 0 ? (
      <optgroup label="Bundled">
        {groups.bundled.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </optgroup>
    ) : null}
    {groups.library.length > 0 ? (
      <optgroup label="My audio">
        {groups.library.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </optgroup>
    ) : null}
    {groups.current === null ? null : (
      <option value={groups.current.value}>{groups.current.label}</option>
    )}
  </>
));

SelectOptions.displayName = "SelectOptions";

/** A sound select: None, a Bundled group, a My audio group, and the Story's own value if neither offers it. */
export const AudioSelect = memo(
  ({label, value, library, onChange, id, describedBy}: AudioSelectProps) => {
    const {rows, settled} = library;
    // Sorting and labelling the rows runs once per (rows, settled, value), not per render.
    const groups = useMemo(
      () =>
        audioSelectOptions({current: value, library: rows, librarySettled: settled}),
      [value, rows, settled],
    );

    return (
      <label className="field">
        <span>{label}</span>
        <select
          id={id}
          value={value ?? NO_AUDIO_VALUE}
          aria-describedby={describedBy}
          onChange={(event) =>
            onChange(
              event.target.value === NO_AUDIO_VALUE
                ? null
                : (event.target.value as AudioRef),
            )
          }
        >
          <SelectOptions groups={groups} />
        </select>
      </label>
    );
  },
);

AudioSelect.displayName = "AudioSelect";

type UnitSliderProps = {
  /** The accessible name, for example "Music volume". */
  label: string;
  /** The visible caption: "Volume", "Ducking". */
  caption: string;
  value: number;
  onChange: (value: number) => void;
};

/** A 0 to 1 slider in steps of 0.05 that shows its number. */
export const UnitSlider = ({label, caption, value, onChange}: UnitSliderProps) => (
  <div className="field range-field">
    <span aria-hidden="true">{caption}</span>
    <div className="range-row">
      <input
        type="range"
        aria-label={label}
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(event) =>
          onChange(Math.round(Number(event.target.value) * 100) / 100)
        }
      />
      <output aria-hidden="true">{String(value)}</output>
    </div>
  </div>
);

type NumberFieldProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Called with every finite number the user types, in range or not: the schema judges it. */
  onCommit: (value: number) => void;
  error?: string;
};

/**
 * A number input that keeps what the user is typing ("1." on the way to
 * "1.5", or an emptied field) and only reports finite numbers. When the
 * Story's value changes from outside (Discard, reset) the text follows it.
 */
export const NumberField = ({
  label,
  value,
  min,
  max,
  step,
  onCommit,
  error,
}: NumberFieldProps) => {
  const errorId = useId();
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText((current) =>
      current.trim() !== "" && Number(current) === value
        ? current
        : String(value),
    );
  }, [value]);

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        onChange={(event) => {
          setText(event.target.value);

          const typed = Number(event.target.value);

          if (event.target.value.trim() !== "" && Number.isFinite(typed)) {
            onCommit(typed);
          }
        }}
        onBlur={() =>
          setText((current) =>
            current.trim() !== "" && Number.isFinite(Number(current))
              ? current
              : String(value),
          )
        }
      />
      {error === undefined ? null : (
        <small id={errorId} className="field-error">
          {error}
        </small>
      )}
    </label>
  );
};
