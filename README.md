# png-squeeze-01-run-20261127

[![png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/kuyang300/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/kuyang300/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Lossless PNG re-encoder for the make.fun png-squeeze-01 bounty: it reads
eight 1280x720 RGBA screenshots from `/input/<id>/image.png` and writes each
one back as the smallest valid PNG it can, in `/output/<id>/image.png`.

## How it works

`main.ts` (Node 22, stdlib only, no network, no clock, fully deterministic)
does, per image:

1. **Decode** the input PNG to RGBA (bit depth 8, colour types 0/2/3/4/6).
2. **Analyse**: opaque? grey? at most 256 colours? a single transparent
   colour that can be keyed by `tRNS` instead of an alpha channel?
3. **Try every exact form** the checker reads: palette (count order and
   luminance order, transparent entries first) when there are at most 256
   colours, grey / grey+alpha when every pixel is grey, RGB / RGBA
   otherwise, plus the `tRNS` key trick when it applies.
4. **Filter every row** with every choice — fixed None/Sub/Up/Average/Paeth,
   minimum-sum, fewest-distinct-pairs, and per-row brute force weighed by a
   real deflate of the row — all computed in one pass over the rows.
5. **Screen** each candidate with zlib level 6, keep the two best, and write
   the smaller of their zlib level 9 streams (default and `Z_FILTERED`
   strategies; the level 6 stream is kept as a candidate too).

## Local test

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Practice-set score: **703,457** (house baseline fixed-paeth scores 420,399
on the same set). All 8 instances answered exactly, deterministic across
runs (two runs from different working directories write byte-identical
files), whole set in ~15 s on 1 CPU (limit 60 s).

## Licence

MIT — see `LICENSE`.
