// Upload limits for /api/parse, shared between the browser and the server.
//
// The server check is the real one. The client check only exists to fail
// fast, so a user who picks a 400 MB file learns that instantly instead of
// after a long upload.
//
// Why these exist at all: /api/parse buffers the whole upload into memory
// (`request.formData()` then `file.arrayBuffer()`), and the App Router has
// no default body size limit -- `bodyParser.sizeLimit` is a Pages Router
// option and does nothing here. Without an explicit cap, one large file
// takes down the container.

/** Biggest upload /api/parse accepts. A survey document is prose, not media. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Biggest extracted document /api/parse sends to the model. Roughly 50k
 * tokens, which leaves the context window comfortable room for the system
 * prompt and the 8k-token answer.
 *
 * Rejected rather than truncated on purpose: a silent truncation drops
 * questions off the end of the survey, and nothing downstream would ever
 * notice they were missing.
 */
export const MAX_DOCUMENT_CHARS = 200_000;

/**
 * Output token budget for a single parse call. Lives here, next to the input
 * caps, so the number used in `messages.create` and the number quoted in the
 * "too long" error can never drift apart -- a wrong number in that message
 * would send someone hunting for a limit that doesn't exist.
 *
 * Both generateQuestions and generateScreener use it.
 */
export const MAX_OUTPUT_TOKENS = 8000;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
