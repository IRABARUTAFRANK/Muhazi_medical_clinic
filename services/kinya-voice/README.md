# Kinyarwanda voice server

The waiting-room screen can say its Kinyarwanda call with a real Kinyarwanda voice (Settings ›
Waiting-room screens › Kinyarwanda voice › "The clinic's voice server"). No browser has such a
voice, so this small service makes the audio from an open Kinyarwanda text-to-speech model.
The app asks it through the edge function `rw-voice` and keeps every sentence it makes in the
`voice` storage bucket, so the service is asked once per new sentence.

Model: [DigitalUmuganda/KinyarwandaTTS_female_voice](https://huggingface.co/DigitalUmuganda/KinyarwandaTTS_female_voice)
(Coqui YourTTS, licence CC-BY-SA 4.0 — credit Digital Umuganda).

## Deploy (Hugging Face Spaces, Docker)

1. Create a Space at huggingface.co/new-space: SDK **Docker**, hardware **CPU basic** (free: it
   sleeps after 48 h without a request and wakes in about a minute; "CPU upgrade" or a
   persistent paid plan keeps it awake).
2. Upload `Dockerfile`, `requirements.txt` and `app.py` from this folder.
3. In the Space's Settings › Variables and secrets add the secret `VOICE_SERVER_KEY`: a long
   random text (for example 40 letters and digits).
4. Wait for the build (10-15 minutes the first time). `https://<owner>-<space>.hf.space/health`
   answers `{"ok": true}`.

Render, Fly.io or a VPS with Docker work the same: build the image, set `VOICE_SERVER_KEY` and
`PORT`, expose the port.

## Connect the app

Set the edge function's secrets (Supabase › Edge Functions › rw-voice › Secrets, or
`npx supabase secrets set …`):

- `VOICE_SERVER_URL` = `https://<owner>-<space>.hf.space` (no trailing slash)
- `VOICE_SERVER_KEY` = the same secret as above

Deploy the function with `pnpm sb:deploy rw-voice`, then choose "The clinic's voice server" on a
screen. If the server is down or slow (more than 8 seconds), the TV falls back to the
browser's voice for that call.

## Try it

```sh
curl -X POST https://<owner>-<space>.hf.space/tts -H "X-Key: <secret>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Umurwayi witwa Mugiraneza Jean, urakenewe muri deparitoma yo gusuzuma."}' \
  -o test.wav
```
