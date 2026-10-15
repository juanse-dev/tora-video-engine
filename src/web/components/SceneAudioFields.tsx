import type {AudioRef} from "../../audio/catalog.ts";
import {DEFAULT_AUDIO_VOLUME} from "../../audio/constants.ts";
import type {
  LibraryAudioChoices,
  SceneAudioRole,
} from "../audio/audioFields.ts";
import type {VisualSceneDraft} from "../visualDraft.ts";
import {AudioSelect, UnitSlider} from "./AudioControls.tsx";

type SceneAudioFieldsProps = {
  scene: VisualSceneDraft;
  library: LibraryAudioChoices;
  onSfxChange: (src: AudioRef | null) => void;
  onVoiceChange: (src: AudioRef | null) => void;
  onVolumeChange: (role: SceneAudioRole, volume: number) => void;
};

/** The selected scene's Sound effect and Voice selects, each with a Volume slider when set. */
export const SceneAudioFields = ({
  scene,
  library,
  onSfxChange,
  onVoiceChange,
  onVolumeChange,
}: SceneAudioFieldsProps) => (
  <div className="scene-audio" data-scene-audio="">
    <div className="scene-audio-row">
      <AudioSelect
        label="Sound effect"
        value={scene.sfx?.src}
        library={library}
        onChange={onSfxChange}
      />
      {scene.sfx === undefined ? null : (
        <UnitSlider
          label="Sound effect volume"
          caption="Volume"
          value={scene.sfx.volume ?? DEFAULT_AUDIO_VOLUME}
          onChange={(volume) => onVolumeChange("sfx", volume)}
        />
      )}
    </div>
    <div className="scene-audio-row">
      <AudioSelect
        label="Voice"
        value={scene.voice?.src}
        library={library}
        onChange={onVoiceChange}
      />
      {scene.voice === undefined ? null : (
        <UnitSlider
          label="Voice volume"
          caption="Volume"
          value={scene.voice.volume ?? DEFAULT_AUDIO_VOLUME}
          onChange={(volume) => onVolumeChange("voice", volume)}
        />
      )}
    </div>
  </div>
);
