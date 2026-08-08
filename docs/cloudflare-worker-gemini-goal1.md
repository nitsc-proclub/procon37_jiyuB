# Cloudflare Workers: Gemini lyrics generation (Goal 1)

The public site is a Cloudflare **Worker Static Assets** deployment, not Cloudflare Pages. The Worker keeps the existing `https://cho-ekaki-uta.nitsc-proclub.workers.dev/` URL, serves the Vite `dist` assets, and handles only `POST /api/gemini/generate-ekaki-uta` before delegating the rest to static assets.

## One-time Cloudflare settings

1. Keep the existing build command `npm run build:deployment-preview`; Goal 1 enables Gemini in that mode while retaining VOICEVOX, demo-records, saving, and timing storage as disabled.
2. Keep the output directory as `dist` if the dashboard asks for one.
3. Add `GEMINI_API_KEY` as an encrypted Worker Secret for Preview first. Do not use a `VITE_` name and do not put the key in `wrangler.jsonc` or an env file committed to Git.
4. Deploy to a Preview URL and verify a drawing returns four lyric lines, kana lines, and the line-to-stroke mappings.
5. After that verification, add the same Secret to Production and promote the deployment.

Optional non-secret Worker variables are `GEMINI_MODEL`, `GEMINI_MODEL_CANDIDATES`, and `GEMINI_MODEL_SUB`. If no candidates are configured, the Worker asks Gemini for available Flash models and falls back to `gemini-2.5-flash-lite`.

## What this release intentionally excludes

- VOICEVOX and audio synthesis
- silent-score animation playback
- demo-record and generation-timing storage

The browser receives Gemini results only. If a later local VOICEVOX stage fails in the full mode, the successful lyrics are retained instead of being discarded.
