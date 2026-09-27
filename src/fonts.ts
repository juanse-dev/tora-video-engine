import "@fontsource-variable/inter/wght.css";
import {useEffect, useState} from "react";
import {
  cancelRender,
  continueRender,
  delayRender,
} from "remotion";

export const CAPTION_FONT_FAMILY = "Inter Variable";

const REQUIRED_FONT_WEIGHTS = [700, 800, 900] as const;

export const useCaptionFont = () => {
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
            ),
          ),
        );

        if (loadedFaces.some((faces) => faces.length === 0)) {
          throw new Error(
            "Bundled caption font failed to load required weights",
          );
        }

        continueRender(handle);
      } catch (error) {
        cancelRender(error);
      }
    };

    void load();
  }, [handle]);
};
