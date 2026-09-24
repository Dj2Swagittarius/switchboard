"""Local speech-to-text via faster-whisper. Called by lib/voicemail.mjs.

Usage: python transcribe.py <audio-file> [model]
Prints one JSON object to stdout. All logging goes to stderr so stdout stays
parseable.
"""
import sys, json, warnings
warnings.filterwarnings("ignore")

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: transcribe.py <file> [model]"})); return 1
    path = sys.argv[1]
    size = sys.argv[2] if len(sys.argv) > 2 else "base.en"
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper not installed (pip install faster-whisper)"})); return 1
    try:
        # int8 on CPU: voicemail is 8 kHz phone audio, so a bigger model buys
        # little. Keeps contention with the LLM down.
        model = WhisperModel(size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(path, beam_size=1, vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
        print(json.dumps({
            "text": text,
            "language": info.language,
            "duration": round(info.duration, 1),
            "model": size,
        }))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)[:300]})); return 1

sys.exit(main())
