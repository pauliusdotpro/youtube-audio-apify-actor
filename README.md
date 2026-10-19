# YouTube to MP3 & Audio Converter

Convert YouTube videos to **MP3, M4A, WAV, FLAC, AAC, Opus, OGG or WebM** audio files. Paste one URL or a thousand, pick a format and quality, optionally trim a clip, and get back a **direct download link** for every video. You can also save each audio file to the run's key-value store.

You pay **only for successful conversions**. Videos that are private, deleted, region-locked, live, or otherwise not convertible are reported in the output and **not charged**.

## What can it do?

- **8 output formats**: `mp3`, `m4a`, `wav`, `flac`, `aac`, `opus`, `ogg`, `webm`
- **Quality control**: `standard`, `best`, or a target bitrate of `128`, `192`, `256` or `320` kbps
- **Clip trimming**: convert only a section by setting start and end times in seconds
- **Batch processing**: many URLs per run, with 3 conversions in parallel by default
- **Accepts any YouTube URL form**: `watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `music.youtube.com`, or a plain 11-character video ID
- **Optional file storage**: save the audio into the Apify key-value store so it stays available after the download link expires
- **Reliable**: the Actor waits for long conversions, honors rate limits, and retries temporary errors on its own

Typical uses: podcast and lecture archiving, building audio datasets you have rights to, transcription and speech-to-text pipelines, and moving your own channel's content into audio platforms.

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `urls` | array of strings | (required) | YouTube video URLs or video IDs. Maximum source length is 3 hours. |
| `format` | string | `mp3` | One of `mp3`, `m4a`, `wav`, `flac`, `aac`, `opus`, `ogg`, `webm`. |
| `quality` | string | `standard` | One of `standard`, `best`, `128`, `192`, `256`, `320`. Bitrates apply to lossy formats. |
| `startTime` | integer | none | Optional clip start, in seconds. Applies to every URL. |
| `endTime` | integer | none | Optional clip end, in seconds. Must be greater than `startTime`. |
| `storeFile` | boolean | `false` | Download each file into the run's key-value store. |
| `maxConcurrency` | integer | `3` | Parallel conversions, from 1 to 5. |

Example input:

```json
{
  "urls": [
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://youtu.be/jNQXAC9IVRw"
  ],
  "format": "mp3",
  "quality": "192",
  "storeFile": false
}
```

## Output

Each input URL produces one item in the dataset:

```json
{
  "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "status": "succeeded",
  "videoId": "jNQXAC9IVRw",
  "link": "https://…/Me%20at%20the%20zoo.mp3?…",
  "linkExpiresAt": "2026-10-19T12:34:56.000Z",
  "fileName": "Me at the zoo.mp3",
  "format": "mp3",
  "quality": "192",
  "contentType": "audio/mpeg",
  "fileSize": 312845,
  "durationSeconds": 19,
  "keyValueStoreKey": null,
  "keyValueStoreUrl": null,
  "error": null,
  "errorCode": null
}
```

A failed item has `"status": "failed"` and gives the reason in `error` and `errorCode` (for example `MEDIA_UNAVAILABLE`, `INVALID_URL` or `VIDEO_TOO_LONG`):

```json
{
  "url": "https://www.youtube.com/watch?v=xxxxxxxxxxx",
  "status": "failed",
  "link": null,
  "error": "This video is unavailable",
  "errorCode": "MEDIA_UNAVAILABLE"
}
```

**The download links are short-lived.** Download the files soon after the run finishes, or set `storeFile: true` to keep a copy in the run's key-value store. The output then includes `keyValueStoreKey` and `keyValueStoreUrl`. Stored files follow your Apify storage retention and count toward your storage usage.

The dataset has two views: **Converted audio** shows all items, and **Failed conversions** shows only the errors. You can export results as JSON, CSV, Excel or XML, or read them through the Apify API.

## Pricing

This Actor uses **pay-per-event** pricing:

| Event | Price |
|---|---|
| `audio-conversion`, charged once per successfully converted video | **$0.01** |

Failed or skipped videos are free. If you set a maximum cost for the run, the Actor stops starting new conversions once that budget is used up, and the remaining URLs are left unprocessed. You may also pay standard Apify platform usage (compute and storage), especially when you use `storeFile`.

## Using it from code

```bash
curl -X POST "https://api.apify.com/v2/acts/ghstudios~youtube-audio-apify-actor/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://www.youtube.com/watch?v=jNQXAC9IVRw"],"format":"mp3"}'
```

You can also use the Apify JavaScript or Python client, schedules, webhooks, and integrations such as Make, Zapier and n8n.

## Limits

- The maximum source video length is 3 hours.
- Live streams, premieres that have not finished, private videos, members-only videos and age- or region-restricted videos may not be convertible. They are reported as failed and are not charged.
- Large lossless files (WAV or FLAC of long videos) take longer and use more storage. With `storeFile`, files above about 500 MB are not stored, but the download link is still returned.

## Legal and acceptable use

**Use this Actor only for content that you own or have the rights or permission to download and convert**, such as your own uploads, Creative Commons or public domain material, or content whose rights holder has authorized you. You are responsible for complying with YouTube's Terms of Service, copyright law and any other laws that apply where you live. Do not use this Actor to infringe copyright or to redistribute protected content.

This Actor is an independent tool. It is **not affiliated with, endorsed by, or sponsored by YouTube or Google LLC**. "YouTube" is a trademark of Google LLC.

## Support

If a video fails to convert and you believe it should work, open an issue on the Actor's **Issues** tab. Include the run ID and the failing URL.
