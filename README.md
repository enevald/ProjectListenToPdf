# ListenToPDF

ListenToPDF turns text-based PDFs into a guided reading and listening experience. It extracts a section outline, highlights the current paragraph, and can read the document aloud. Its optional conversational companion answers questions about the PDF and can accept voice messages.

## Run locally (Linux)

From the project folder, activate the existing virtual environment and start the app:

```sh
cd ~/Desktop/Quant/ProjectListenToPdf
source .venv/bin/activate
python main.py
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000) in your browser. To stop the app, press `Ctrl+C` in the terminal.

For a fresh checkout, create the environment and install the app dependencies first:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

## Set up the local voice companion

The companion uses open-source models running on your own computer:

- **Ollama** runs the local chat model.
- **faster-whisper** transcribes microphone recordings locally.
- **Piper** generates the spoken voice locally.

No hosted AI API key is used. Model and PDF text are sent only to the local app/model services unless you explicitly change their local endpoint settings. This is turn-based voice chat, not a live, interruptible phone call.

The optional voice packages are installed in this checkout's `.venv`. For a fresh checkout, install them with Python 3.10 or newer:

```sh
python -m pip install -r requirements-local-voice.txt
```

Install [Ollama](https://ollama.com/download), start it, and download the compact chat model used by this setup:

```sh
ollama pull qwen2.5:0.5b
```

If Ollama is not already running as a background service, start it in a separate terminal and leave that terminal open:

```sh
ollama serve
```

Download a Piper voice to a persistent location:

```sh
mkdir -p "$HOME/.local/share/listentopdf/piper"
cd "$HOME/.local/share/listentopdf/piper"
python -m piper.download_voices en_US-lessac-medium
```

### Change voice and naturalness from the player

The player has an **AI voice** selector and a **Naturalness** slider. The slider changes how much pitch and timing variation Piper uses; lower settings sound more even, while higher settings add more variation. Changes are saved in this browser and used for narration and spoken companion replies. If playback is in progress, a changed setting starts the current paragraph again.

The selector lists Piper voices installed in the configured voice folder. To add another voice, download it into that same folder. For example:

```sh
cd ~/Desktop/Quant/ProjectListenToPdf
.venv/bin/python -m piper.download_voices \
  --download-dir "$HOME/.local/share/listentopdf/piper" en_US-amy-medium
```

Refresh the reader to see the new voice in the selector. To make it the fallback voice for a new browser, stop ListenToPDF with `Ctrl+C` and restart it with the new model file:

```sh
cd ~/Desktop/Quant/ProjectListenToPdf
source .venv/bin/activate
export LOCAL_VOICE_ENABLED=1
export OLLAMA_MODEL=qwen2.5:0.5b
export WHISPER_MODEL=tiny
export PIPER_VOICE_MODEL="$HOME/.local/share/listentopdf/piper/en_US-amy-medium.onnx"
python main.py
```

You can use another Piper voice name in the download command. Higher-quality variants, such as `en_US-lessac-high`, may sound clearer but use more disk space and processing than `medium`. Naturalness changes how the current Piper voice speaks; it does not change the voice model itself. Piper is still neural text-to-speech and will sound synthetic compared with a human or premium hosted voice. Keep in mind that hosted speech services send the text being read to that provider.

Each time you start the companion, set its configuration in the same terminal:

```sh
cd ~/Desktop/Quant/ProjectListenToPdf
source .venv/bin/activate
export LOCAL_VOICE_ENABLED=1
export OLLAMA_MODEL=qwen2.5:0.5b
export WHISPER_MODEL=tiny
export PIPER_VOICE_MODEL="$HOME/.local/share/listentopdf/piper/en_US-lessac-medium.onnx"
python main.py
```

The companion will then be available at [http://127.0.0.1:5000](http://127.0.0.1:5000). The first voice recording downloads the faster-whisper `tiny` model. Use `WHISPER_MODEL` to select another model if you have enough disk space. Piper loads the configured voice once and reuses it for narration and replies.

The default chat model is the compact `qwen2.5:0.5b`; its answers are less capable than larger models. Override it with `OLLAMA_MODEL` if you have enough memory and disk space. Ollama's default local address is `http://127.0.0.1:11434`; override it with `OLLAMA_URL` only if your local service uses a different address.

On Windows PowerShell, set `$env:LOCAL_VOICE_ENABLED = "1"` and `$env:PIPER_VOICE_MODEL = "C:\path\to\en_US-lessac-medium.onnx"` before starting the app.

Local AI endpoints are disabled unless `LOCAL_VOICE_ENABLED=1` is set. Keep this app on your own computer when enabling them; do not expose the local AI endpoints to the public internet. The compact chat and Whisper models are intended for machines with limited disk space; larger models need more free space and will provide better results.

The reader accepts text-based PDFs up to 25 MB. Image-only PDFs need OCR and are not currently supported. The existing `/convert_pdf` endpoint remains available for generating an MP3.
