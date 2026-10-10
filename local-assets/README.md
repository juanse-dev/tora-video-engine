# Local assets

Put your own images here so the CLI can render Stories that use them.
Everything in this folder except this README is ignored by git, and nothing here
is uploaded anywhere.

```text
local-assets/
  poses/         images usable as local:pose:sha256:...
  backgrounds/   images usable as local:background:sha256:...
```

1. Copy the exact original image files into the matching folder. Create the
   folder if it does not exist. Subfolders are fine; symbolic links are skipped.
2. Run `npm run assets` to print the `local:...` ref for every file.
3. Render with `npm run video -- stories/my-story.yaml`. If a referenced image is
   missing, the render stops before it starts and says which ref and which folder.

Files are matched by content (SHA-256), not by name or extension, so a renamed
copy of the same image works. Only static PNG, JPEG and WebP images up to
25 MiB, 8192 pixels per side and 50 million pixels in total are supported.
