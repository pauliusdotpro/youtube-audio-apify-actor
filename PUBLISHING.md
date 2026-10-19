# Publishing checklist (owner only)

This Actor is a thin client for `https://api-youtubemp3.paulius.pro`. It authenticates with the direct (non-RapidAPI) Bearer token.

## 1. Push the code

```bash
npm install -g apify-cli        # or: brew install apify-cli
apify login                     # paste your Apify API token
cd integrations/apify-actor
apify push                      # creates or updates <username>/youtube-audio-converter and builds it
```

## 2. Set the secret environment variable

In Apify Console, open **Actors → youtube-audio-converter → Source → Environment variables** and add:

| Name | Value | Secret |
|---|---|---|
| `YTMP3_API_TOKEN` | the production `API_TOKEN` of the API | **yes** |
| `YTMP3_API_BASE_URL` (optional) | override the API base URL, default `https://api-youtubemp3.paulius.pro` | no |
| `MAX_STORED_FILE_BYTES` (optional) | largest file stored when `storeFile` is on, default 524288000 | no |

Rebuild after you change environment variables, because they are applied at build time. Never put the token in the input schema, the README or `actor.json`.

Optional: create a dedicated API token for Apify traffic so you can rotate it and track usage separately.

## 3. Configure pay-per-event monetization

Open **Actor → Publication → Monetization**, choose **Pay per event**, and add the event from `.actor/pay_per_event.json`. That file is only a reference. The Console is where the pricing actually takes effect.

| Event name (must match code) | Title | Price |
|---|---|---|
| `audio-conversion` | Audio conversion | $0.01 |

- The code calls `Actor.charge({ eventName: 'audio-conversion' })` once, after each successful conversion and after the dataset push. Failures are never charged.
- The Actor respects the user's "max total charge" budget. It stops starting new conversions once no budget is left.
- Optionally, turn on Apify's synthetic `apify-actor-start` event or charge for platform usage. Check your margin against the API's real cost per conversion, including bandwidth when users enable `storeFile`.

## 4. Store listing

- Title: "YouTube to MP3 & Audio Converter". Categories: Videos, Automation and Developer tools.
- `README.md` becomes the Store page. Replace `<username>` in the API example.
- Run it once from the Console with the prefilled input to check that you get a `succeeded` item. Then publish.

## Local testing

```bash
npm install
YTMP3_API_TOKEN=... apify run -i '{"urls":["https://www.youtube.com/watch?v=jNQXAC9IVRw"]}'
# or without the CLI:
APIFY_LOCAL_STORAGE_DIR=./storage YTMP3_API_TOKEN=... node src/main.js   # input from ./storage/key_value_stores/default/INPUT.json
```

If `YTMP3_API_TOKEN` is missing, the run fails right away with a clear status message. If the token is wrong, the API answers 403 and the run fails with "rejected the Actor credentials".
