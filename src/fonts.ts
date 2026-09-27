import "@fontsource-variable/inter/wght.css";
import {useEffect, useState} from "react";
import {
  cancelRender,
  continueRender,
  delayRender,
} from "remotion";
import {
  loadCaptionFontForText,
} from "./fontCoverage.ts";
import type {Story} from "./story/types.ts";

const getStoryCaptionText = (story: Story): string =>
  story.scenes.map((scene) => scene.text).join("\n");

export const useCaptionFont = (story: Story) => {
  const captionText = getStoryCaptionText(story);
  const [handle] = useState(() =>
    delayRender("Loading bundled caption font"),
  );

  useEffect(() => {
    const load = async () => {
      try {
        await loadCaptionFontForText(
          captionText,
          (font, text) => document.fonts.load(font, text),
        );

        continueRender(handle);
      } catch (error) {
        cancelRender(error);
      }
    };

    void load();
  }, [captionText, handle]);
};
