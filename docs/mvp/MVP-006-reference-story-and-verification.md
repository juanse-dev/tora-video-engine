# MVP-006 — Reference story and verification

> Status: **Verified / MVP complete**. Automated checks cover the canonical story, exact timeline, YAML-only mutation behavior, render command, and reference artifact generation. The CI reference MP4 was inspected and passed the visual checklist.

## Goal

Close the MVP with one canonical end-to-end story and enough automated verification to make later refactors safe.

## Golden story

Use \`stories/friday-deploy.yaml\` as the canonical MVP fixture:

~~~yaml
title: "Deploy Friday"

scenes:
  - type: intro
    pose: formal
    background: office
    animation: fade
    text: "Tora tiene una regla."
    duration: 3

  - type: dialogue
    pose: confused
    background: office
    animation: float
    text: "Pero es solo un cambio pequeño..."
    duration: 3

  - type: chaos
    pose: panic
    background: server-room
    text: "Production is down."
    duration: 3

  - type: punchline
    pose: coffee
    background: office
    animation: slowZoom
    text: "Era un cambio pequeño."
    duration: 3
~~~

At 30 FPS this story must compile to:

~~~text
scene 0: from   0, duration 90
scene 1: from  90, duration 90
scene 2: from 180, duration 90
scene 3: from 270, duration 90
total: 360 frames / 12 seconds
~~~

## Automated verification

The MVP does not need sophisticated visual regression infrastructure.

Required automated checks:

### Schema tests

Cover valid and invalid story documents as described in MVP-003.

### Timeline tests

Assert exact start frames and total duration for the golden story.

### Render smoke test

Provide a repeatable way to render the golden story and verify that:

- the command exits successfully;
- the expected MP4 exists;
- the file is non-empty.

If inexpensive metadata inspection is already available in the toolchain, also verify dimensions and duration. Do not add a large dependency solely for this check.

## Manual visual checklist

Before tagging v0.1, inspect the reference render once and confirm:

- scene order matches YAML;
- Tora uses formal → confused → panic → coffee;
- office → office → server-room → office backgrounds are correct;
- all captions are visible and readable;
- fade is visible in the intro;
- float is visible in dialogue;
- slowZoom is visible in the punchline;
- there are no blank frames between scenes;
- there is no unexpected clipping;
- output is vertical.

## Mutation check

As a final architecture test, make temporary changes to the YAML only:

- swap two scenes;
- change a caption;
- change a duration;
- change a valid pose;
- change a valid background;
- change an animation.

The result must change accordingly without modifying React code.

These changes do not need to be committed.

## Documentation

Update the root README so that:

- the documented MVP matches the implemented v0.1 scope;
- \`docs/mvp/README.md\` is linked as the implementation roadmap;
- the actual development and render commands are accurate.

## Verification evidence

The reference artifact produced by CI was inspected after the automated checks passed:

- codec: H.264;
- dimensions: 1080 × 1920;
- frame rate: 30 FPS;
- duration: 12.000 seconds;
- frame count: 360;
- scene order: intro → dialogue → chaos → punchline;
- Tora poses: formal → confused → panic → coffee;
- backgrounds: office → office → server-room → office;
- fade, float, and slowZoom are visibly active;
- captions remain visible with no unexpected clipping;
- sampled scene boundaries contain no blank frames.

## MVP completion checklist

- [x] MVP-001 accepted
- [x] MVP-002 accepted
- [x] MVP-003 accepted
- [x] MVP-004 accepted
- [x] MVP-005 accepted
- [x] reference story renders successfully
- [x] schema tests pass
- [x] timeline tests pass
- [x] render smoke test passes
- [x] manual visual checklist passes
- [x] YAML mutation check passes
- [x] README commands match reality

## Release

When every item above is complete, the project can be considered **Tora Video Engine v0.1 MVP**.

A tag is optional, but if releases are being used, \`v0.1.0\` is the natural first milestone.

## Done when

The repository demonstrates, from a clean checkout, the full deterministic path:

~~~text
YAML → validation → timeline → reusable visuals → Remotion → MP4
~~~

with no application code changes required to alter the reference story.
