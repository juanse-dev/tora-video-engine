import type {AudioNotice} from "../audio/audioNotices.ts";
import {retryBundledAudio} from "../audio/bundledAudio.ts";

type AudioNoticesProps = {
  notices: readonly AudioNotice[];
  /** The DOM id of this block: the field's select names it in `aria-describedby`. */
  id: string;
  /** Which warnings these are, for tests: `music`, `sfx` or `voice`. */
  name: string;
  /** The DOM id of the field's select, which gets the focus back after Retry. */
  focusId: string;
};

/**
 * The warnings next to one control. The `role="status"` block is always
 * mounted and only its text changes (a live region that appears already full
 * is not reliably announced), and the field's select is described by it. A
 * `Retry` button disappears as soon as the sound is loading again, so focus
 * moves back to the select instead of falling to the page.
 */
export const AudioNotices = ({notices, id, name, focusId}: AudioNoticesProps) => (
  <div className="audio-notices" id={id} role="status" data-audio-notices={name}>
    {notices.map((notice) => (
      <p key={notice.text}>
        <span>{notice.text}</span>
        {notice.retry === undefined ? null : (
          <button
            type="button"
            aria-label={`Retry loading ${notice.retry.label}`}
            onClick={() => {
              retryBundledAudio(notice.retry!.id);
              document.getElementById(focusId)?.focus();
            }}
          >
            Retry
          </button>
        )}
      </p>
    ))}
  </div>
);
