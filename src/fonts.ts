import "@fontsource-variable/inter/wght.css";
import {useEffect} from "react";
import {useBufferState, useDelayRender} from "remotion";
import {loadCaptionFontForText} from "./fontCoverage.ts";
import type {Story} from "./story/types.ts";

const getStoryCaptionText = (story: Story): string =>
  story.scenes.map((scene) => scene.text).join("\n");

export const useCaptionFont = (story: Story) => {
  const captionText = getStoryCaptionText(story);
  const {delayPlayback} = useBufferState();
  const {cancelRender, continueRender, delayRender} = useDelayRender();

  useEffect(() => {
    const renderHandle = delayRender("Loading bundled caption font");
    const playbackHandle = delayPlayback();
    let active = true;
    let renderSettled = false;
    let playbackSettled = false;

    const unblockPlayback = () => {
      if (playbackSettled) {
        return;
      }

      playbackSettled = true;
      playbackHandle.unblock();
    };

    const continueRenderOnce = () => {
      if (renderSettled) {
        return;
      }

      renderSettled = true;
      continueRender(renderHandle);
    };

    const load = async () => {
      try {
        await loadCaptionFontForText(
          captionText,
          (font, text) => document.fonts.load(font, text),
        );

        if (!active) {
          return;
        }

        unblockPlayback();
        continueRenderOnce();
      } catch (error) {
        if (!active) {
          return;
        }

        unblockPlayback();
        renderSettled = true;
        cancelRender(error);
      }
    };

    void load();

    return () => {
      active = false;
      unblockPlayback();
      continueRenderOnce();
    };
  }, [
    cancelRender,
    captionText,
    continueRender,
    delayPlayback,
    delayRender,
  ]);
};
