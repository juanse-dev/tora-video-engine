# Tora Video Engine demo

This directory contains a checked-in showcase render of the current engine.

- [Watch or download the demo reel](./tora-video-engine-demo.mp4)
- Source story: [`stories/demo-reel.yaml`](../stories/demo-reel.yaml)
- Format: H.264 MP4
- Resolution: 1080 × 1920
- Frame rate: 30 FPS
- Duration: 32 seconds

The checked-in MP4 is re-encoded at a higher compression level to keep the repository lightweight while preserving the full project resolution. The source YAML remains the reproducible version of the demo.

To regenerate the demo from the engine:

```bash
npm run video -- stories/demo-reel.yaml
```

This produces:

```text
output/demo-reel.mp4
```

The story intentionally exercises all current visual primitives:

- all four scene presets: `intro`, `dialogue`, `chaos`, `punchline`;
- all four Tora poses: `formal`, `confused`, `panic`, `coffee`;
- both backgrounds: `office` and `server-room`;
- all three animations: `fade`, `float`, `slowZoom`;
- animation overrides;
- variable scene durations;
- short and long captions.
