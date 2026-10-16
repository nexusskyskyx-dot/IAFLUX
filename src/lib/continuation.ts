/**
 * Resuming an answer that a platform time limit cut short.
 *
 * A hosted function cannot outlive its request budget, so a long answer is
 * finished by asking the model to carry on from the exact point it stopped. The
 * partial text travels inside a normal user message rather than as an assistant
 * prefill: not every provider accepts a trailing assistant turn, and this keeps
 * the existing "conversation ends with a user message" rule intact.
 */

/** Extra attempts after the first request. Bounded so a confused model cannot loop. */
export const MAX_CONTINUATIONS = 4;

/** Characters of the partial answer echoed back to the model. */
const DEFAULT_TAIL_BUDGET = 90_000;

/** Chars held back at the start of a continuation to detect verbatim repeats. */
export const OVERLAP_WINDOW = 512;

function insideFence(text: string): boolean {
  // An odd number of ``` markers means the last fence was never closed.
  return (text.match(/```/g) || []).length % 2 === 1;
}

export function continuationInstruction(partial: string, budget = DEFAULT_TAIL_BUDGET): string {
  const limit = Math.max(4_000, Math.floor(budget));
  const tail = partial.length > limit ? partial.slice(-limit) : partial;
  const lines = [
    'You were writing an answer and it was cut off by a platform time limit. Continue it now.',
    '',
    'Rules:',
    '- Output ONLY the remaining text, starting at the exact point where it stopped.',
    '- Do not repeat, restate, summarise or rewrite any part of what you already wrote.',
    '- Do not add a preamble, apology, heading, or any comment about being cut off.',
    insideFence(tail)
      ? '- You were inside a fenced code block that never closed. Write only the remaining lines of that block, then close it with a line containing three backticks.'
      : '- Do not open a new code block unless the content genuinely calls for one.',
    '- Keep the same language, tone, formatting and indentation.',
  ];
  if (partial.length > limit) lines.push('- Only the tail of what you had written is shown; carry on from it.');
  lines.push('', '<answer_so_far>', tail, '</answer_so_far>');
  return lines.join('\n');
}

/**
 * Remove a verbatim repeat from the start of a continuation.
 *
 * Models occasionally restart instead of continuing. Compare the incoming text
 * against the tail of what we already have and drop the duplicated prefix,
 * checking the longest overlap first.
 */
export function stripOverlap(existing: string, incoming: string, maxOverlap = 2_000): string {
  if (!existing || !incoming) return incoming;
  const limit = Math.min(maxOverlap, existing.length, incoming.length);
  for (let size = limit; size > 0; size -= 1) {
    if (existing.endsWith(incoming.slice(0, size))) return incoming.slice(size);
  }
  return incoming;
}
