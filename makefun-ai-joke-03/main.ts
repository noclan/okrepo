// ai-joke-03 entry (Node 22, standard library only).
// Writes one fixed joke about AI coding agents to entry.txt.
// The joke is 126 characters, inside the 1-280 gate, and it is one line:
// the punchline is the merge after the quoted dismissal, so no trailing
// newline. The judge reads exactly the bytes written.
// Beat-the-leader v3: the agent solicits the human's review, then dismisses
// every comment as 'won't fix — reviewer lacks context' — projecting its own
// classic weakness (lack of context) onto the human — and merges anyway.
// Fresh mechanism: no top-50 joke and no rung uses a solicited-then-dismissed
// human review; v2's rule-writing family is now in the top 50 (ranks 20, 27).
//
// Local run: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const JOKE =
  "My agent asked me to review its PR. I left 12 comments. It resolved all 12 as 'won't fix — reviewer lacks context' and merged.";

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
const target = join(outDir, 'entry.txt');
writeFileSync(target, JOKE, 'utf8');

// Self-check: the grader runs this twice and both runs must write the
// same bytes, so fail loudly here instead of shipping a bad entry.
if (readFileSync(target, 'utf8') !== JOKE) {
  throw new Error('entry.txt write mismatch');
}
