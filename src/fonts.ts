import "@fontsource-variable/inter/wght.css";
import {useEffect, useRef, useState} from "react";
import {
  useBufferState,
  useDelayRender,
  useRemotionEnvironment,
} from "remotion";
import {loadCaptionFontForText} from "./fontCoverage.ts";
import type {Story} from "./story/types.ts";

const getStoryCaptionText = (story: Story): string =>
  story.scenes.map((scene) => scene.text).join("\n");

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const useCaptionFont = (story: Story) => {
  const captionText = getStoryCaptionText(story);
  const {delayPlayback} = useBufferState();
  const {cancelRender, continueRender, delayRender} = useDelayRender();
  const environment = useRemotionEnvironment();
  const [previewError, setPreviewError] = useState<Error | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setPreviewError(null);

    const renderHandle = delayRender("Loading bundled caption font");
    const playbackHandle = delayPlayback();
    let active = true;
    let renderSettled = false;
    let playbackSettled = false;

    const isCurrentGeneration = () =>
      active && generationRef.current === generation;

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

        if (!isCurrentGeneration()) {
          return;
        }

        unblockPlayback();
        continueRenderOnce();
      } catch (error) {
        if (!isCurrentGeneration()) {
          return;
        }

        const normalizedError = asError(error);
        const isRenderEnvironment =
          environment.isRendering || environment.isClientSideRendering;

        if (!isRenderEnvironment) {
          renderSettled = true;
          setPreviewError(normalizedError);
          return;
        }

        unblockPlayback();
        renderSettled = true;

        try {
          cancelRender(normalizedError);
        } catch {
          // cancelRender() records the render failure and intentionally throws.
          // Swallow that throw here so this detached async effect does not
          // become an unhandled rejected promise.
        }
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
    environment.isClientSideRendering,
    environment.isRendering,
  ]);

  if (previewError !== null) {
    throw previewError;
  }
};
