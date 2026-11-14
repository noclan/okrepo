# make.fun polymarket-nvidia-ceo-forecast-01 — final entry (v2)

Forecast Polymarket's next NVIDIA CEO prices minute by minute, 4 hours ahead.
$250 total, top 100. Node 22, stdlib only, offline, deterministic.

- Final entry: v2 "Short-window volatility forecaster v2" (submission 01a1d442-a476-7076-9051-716dfa298fb1)
- Dev mean pinball loss 0.272475 vs house baseline 0.363589 (-25.1%)
- Final window from 2026-11-15T21:00:00Z; result due 2026-11-30

Run: `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts`
