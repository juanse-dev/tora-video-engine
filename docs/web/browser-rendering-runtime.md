# Browser rendering runtime notes

WEB-006 renders H.264 MP4 files in the browser with `@remotion/web-renderer@4.0.529`. Tora does not add a server, serverless render function, database, or cloud render queue.

## Runtime contract

Browser export uses the same `ToraVideo` component, Story input, dimensions, FPS, timeline, bundled assets, and caption font path as Player and CLI rendering.

The supported WEB-006 path is deliberately narrower than Remotion's full client-render API:

- container: MP4;
- video codec: H.264;
- dimensions: 1080 × 1920;
- frame rate: 30 FPS, with each browser-encoded `VideoFrame` assigned an explicit `33,333 µs` duration through `onFrame` so the last frame contributes to container duration;
- audio: disabled with `muted: true`;
- output target: `web-fs`;
- HTML-in-canvas capture: disabled.

If capability detection cannot encode the requested video, cannot resolve `web-fs`, or the browser lacks Web Locks, MP4 export stays disabled while preview, Story editing, YAML export, and the local CLI remain usable.

## Cross-tab rendering and OPFS

All Tora bundles that use Remotion's shared same-origin `__remotion_render:` OPFS prefix must also use the unversioned Web Lock:

`tora-video-engine:web-fs-render`

The lock covers:

1. bounded pre-render cleanup of every `__remotion_render:` entry;
2. `renderMediaOnWeb()`;
3. the public Remotion `getBlob()`;
4. post-render materialization of one independent download Blob while the OPFS backing file still exists;
5. success-path browser download handoff;
6. bounded post-render cleanup.

Cleanup re-enumerates the prefix and retries with the WEB-006 backoff schedule before declaring `cleanup-blocked`. A blocked cleanup keeps the lock until cleanup succeeds or the page is unloaded.

Chrome can keep Remotion's public `web-fs` Blob lazily dependent on its OPFS backing file, and an automatic download may still be reading that backing file after its download event starts. Tora therefore materializes one independent Blob snapshot after rendering completes and before post-render cleanup, then hands that snapshot to the browser and enters a non-cancellable finalizing phase until cleanup releases the render lock. Rendering itself still streams to `web-fs`; the full-payload copy exists only after the completed MP4 is available. Tora adds no further payload copy and no additional encoded-file-size limit.

## Cancellation

Each render owns an `AbortController`. Cancel Render aborts the current Remotion render, waits for it to settle, and runs the same locked post-render cleanup before the lifecycle completes.

Story- and draft-mutating controls are disabled while rendering, cancelling, or finalizing so a successful MP4 represents the visible frozen Story snapshot. Cancel is no longer offered after the MP4 has been handed to the browser download flow.

## Remotion telemetry

Client-side Remotion rendering is not a fully offline operation.

In Remotion 4.0.529, `renderMediaOnWeb()` registers a `web-render` usage event through Remotion's licensing runtime. The event includes the page origin, render success/failure state, still/video classification, production/development classification, and a configured license key when applicable. The network request also necessarily exposes the end user's IP address to the upstream endpoint.

According to Remotion's telemetry documentation, the render's video content and Tora Story/user content are not sent as part of this telemetry event. Telemetry-request failure does not turn a completed media render into a failed Tora render.

Production privacy and CSP review must therefore allow for the upstream Remotion licensing/telemetry request rather than describing browser rendering as zero-network or fully offline.

## License key configuration

Browser code may read:

`VITE_REMOTION_LICENSE_KEY`

Vite variables are public client-side configuration. Only a Remotion key explicitly intended to be exposed to end-user browsers may be placed there. Never put a private/server-side secret in this variable.

Tora does not default to `"free-license"`. Free License eligibility must be verified against the current Remotion license terms before production deployment. If eligible, `VITE_REMOTION_LICENSE_KEY=free-license` may be configured intentionally; otherwise use the appropriate client-safe Remotion license configuration.

WEB-007 must record the production licensing basis and CSP/privacy decision before deployment is considered complete.
