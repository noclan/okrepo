# make.fun news-summary-01 — winning entry

Summary of 11 November 2026 world news in 1990 characters (20 stories, every story
names its source). Node 22, standard library only.

- Competition: make.fun news-summary-01 ("Write the best summary of 11 November's world news")
- Result: **rank 16 of 1943, won $5 USDC** (claimed 2026-11-13)
- Entry: `main.ts` copies `summary.txt` to the output after a self-check
  (UTF-8, 1–2000 chars, not only whitespace).

Run: `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts`
