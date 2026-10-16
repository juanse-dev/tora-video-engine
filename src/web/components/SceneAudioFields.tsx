import {useId} from "react";
import type {AudioRef} from "../../audio/catalog.ts";
import {DEFAULT_AUDIO_VOLUME} from "../../audio/constants.ts";
import type {
  LibraryAudioChoices,
  SceneAudioRole,
} from "../audio/audioFields.ts";
import type {VisualSceneDraft} from "../visualDraft.ts";
import type {SceneAudioNotices} from "../audio/audioNotices.ts";
import {AudioNotices} from "./AudioNotices.tsx";
import {AudioSelect, UnitSlider} from "./AudioControls.tsx";

type SceneAudioFieldsProps = {
  scene: VisualSceneDraft;
  library: LibraryAudioChoices;
  /** The plan's warnings for this scene's sound effect and voice. */
  notices: SceneAudioNotices;
  onSfxChange: (src: AudioRef | null) => void;
  onVoiceChange: (src: AudioRef | null) => void;
  onVolumeChange: (role: SceneAudioRole, volume: number) => void;
};

/** The selected scene's Sound effect and Voice selects, each with a Volume slider when set. */
export const SceneAudioFields = ({
  scene,
  library,
  notices,
  onSfxChange,
  onVoiceChange,
  onVolumeChange,
}: SceneAudioFieldsProps) => {
  const id = useId();

  return (
    <div className="scene-audio" data-scene-audio="">
      <div className="scene-audio-row">
        <AudioSelect
          id={`${id}-sfx`}
          describedBy={`${id}-sfx-notices`}
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
        <AudioNotices
          id={`${id}-sfx-notices`}
          name="sfx"
          focusId={`${id}-sfx`}
          notices={notices.sfx}
        />
      </div>
      <div className="scene-audio-row">
        <AudioSelect
          id={`${id}-voice`}
          describedBy={`${id}-voice-notices`}
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
        <AudioNotices
          id={`${id}-voice-notices`}
          name="voice"
          focusId={`${id}-voice`}
          notices={notices.voice}
        />
      </div>
    </div>
  );
};
