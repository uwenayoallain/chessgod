Place Stockfish WASM assets here:
- sf_19.js
- sf_19.wasm
- nn-1a298aa575a0.nnue   (Stockfish 19 net)

sf_19 is a single-net build. The worker still understands older dual-net builds
so the loading contract remains safe if the package changes again.

The JS and WASM files are refreshed from node_modules/@lichess-org/stockfish-web.
The NNUE files are downloaded into this folder during frontend install/startup.
Net filenames are pinned in scripts/sync-stockfish-assets.mjs and must be
updated together with the @lichess-org/stockfish-web version — see that
package's README for the names matching each build target.
