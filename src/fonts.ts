import "@fontsource-variable/inter/wght.css";
import {useEffect, useState} from "react";
import {
  cancelRender,
  continueRender,
  delayRender,
} from "remotion";
import type {Story} from "./story/types.ts";

export const CAPTION_FONT_FAMILY = "Inter Variable";

const REQUIRED_FONT_WEIGHTS = [700, 800, 900] as const;

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
        const loadedFaces = await Promise.all(
          REQUIRED_FONT_WEIGHTS.map((weight) =>
            document.fonts.load(
              `${weight} 16px "${CAPTION_FONT_FAMILY}"`,
              captionText,
            ),
          ),
        );

        if (loadedFaces.some((faces) => faces.length === 0)) {
          throw new Error(
            "Bundled caption font failed to load required weights or story subsets",
          );
        }

        continueRender(handle);
      } catch (error) {
        cancelRender(error);
      }
    };

    void load();
  }, [captionText, handle]);
};
