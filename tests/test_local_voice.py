import io
import json
import os
import sys
import tempfile
import unittest
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

import local_voice
import main


class LocalVoiceRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = main.app.test_client()
        self.local_voice_enabled = patch.dict(os.environ, {"LOCAL_VOICE_ENABLED": "1"})
        self.local_voice_enabled.start()

    def tearDown(self):
        self.local_voice_enabled.stop()

    def test_voice_routes_are_disabled_without_opt_in(self):
        with patch.dict(os.environ, {"LOCAL_VOICE_ENABLED": ""}):
            response = self.client.post(
                "/api/voice/chat",
                json={"messages": [{"role": "user", "content": "Hello"}], "documentText": "PDF text"},
            )
        self.assertEqual(response.status_code, 503)
        self.assertIn("disabled", response.get_json()["error"])

    def test_voice_status_does_not_mark_an_empty_piper_model_ready(self):
        model_path = os.path.join(os.getcwd(), "empty-piper-model.onnx")
        with open(model_path, "wb"):
            pass
        self.addCleanup(os.remove, model_path)
        with patch.dict(os.environ, {"PIPER_VOICE_MODEL": model_path}):
            status = local_voice.voice_status()
        self.assertFalse(status["speech_ready"])

    def test_chat_route_returns_local_model_reply(self):
        with patch.object(main, "local_chat", return_value="A concise answer."):
            response = self.client.post(
                "/api/voice/chat",
                json={"messages": [{"role": "user", "content": "What is this about?"}], "documentText": "PDF text"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"reply": "A concise answer."})

    def test_speech_route_returns_wav_audio(self):
        with patch.object(main, "synthesize", return_value=b"RIFFfake-wav") as synthesize_mock:
            response = self.client.post(
                "/api/voice/speech",
                json={"text": "Read this aloud.", "voice": "en_US-amy-medium.onnx", "naturalness": 70},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "audio/wav")
        self.assertEqual(response.data, b"RIFFfake-wav")
        synthesize_mock.assert_called_once_with(
            "Read this aloud.", voice="en_US-amy-medium.onnx", naturalness=70
        )

    def test_speech_uses_selected_voice_and_naturalness(self):
        with tempfile.TemporaryDirectory() as voice_directory:
            default_voice = os.path.join(voice_directory, "default.onnx")
            selected_voice = os.path.join(voice_directory, "selected.onnx")
            for path in (default_voice, selected_voice):
                with open(path, "wb") as voice_file:
                    voice_file.write(b"model")
            fake_voice = Mock()
            fake_voice.config = SimpleNamespace(noise_scale=0.667, noise_w_scale=0.8)

            def write_wav(_text, wav_file, syn_config):
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(22050)
                wav_file.writeframes(b"\0\0")

            fake_voice.synthesize_wav.side_effect = write_wav
            piper_package = ModuleType("piper")
            piper_package.__path__ = []
            piper_config_module = ModuleType("piper.config")
            piper_config_module.SynthesisConfig = lambda **kwargs: SimpleNamespace(**kwargs)
            piper_voice_module = ModuleType("piper.voice")
            piper_voice_module.PiperVoice = SimpleNamespace(load=Mock(return_value=fake_voice))
            with (
                patch.dict(os.environ, {"PIPER_VOICE_MODEL": default_voice}),
                patch.dict(
                    sys.modules,
                    {
                        "piper": piper_package,
                        "piper.config": piper_config_module,
                        "piper.voice": piper_voice_module,
                    },
                ),
            ):
                audio = local_voice.synthesize("Hello.", voice="selected.onnx", naturalness=100)

            self.assertTrue(audio.startswith(b"RIFF"))
            piper_voice_module.PiperVoice.load.assert_called_once_with(selected_voice)
            synthesis_config = fake_voice.synthesize_wav.call_args.kwargs["syn_config"]
            self.assertAlmostEqual(synthesis_config.noise_scale, 0.667 * 1.5)
            self.assertAlmostEqual(synthesis_config.noise_w_scale, 0.8 * 1.5)

    def test_speech_rejects_uninstalled_voice_selection(self):
        with tempfile.TemporaryDirectory() as voice_directory:
            configured_voice = os.path.join(voice_directory, "default.onnx")
            with open(configured_voice, "wb") as voice_file:
                voice_file.write(b"model")
            with patch.dict(os.environ, {"PIPER_VOICE_MODEL": configured_voice}):
                with self.assertRaises(local_voice.VoiceServiceError) as raised:
                    local_voice.synthesize("Hello.", voice="../outside.onnx")
        self.assertEqual(raised.exception.status_code, 400)

    def test_transcription_route_returns_local_transcript(self):
        with patch.object(main, "transcribe", return_value="What does this mean?"):
            response = self.client.post(
                "/api/voice/transcribe",
                data={"audio": (io.BytesIO(b"audio"), "message.webm", "audio/webm")},
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"transcript": "What does this mean?"})

    def test_transcription_route_rejects_unsupported_audio(self):
        response = self.client.post(
            "/api/voice/transcribe",
            data={"audio": (io.BytesIO(b"audio"), "message.txt", "text/plain")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 415)

    def test_chat_sends_document_as_untrusted_local_context(self):
        model_response = io.BytesIO(json.dumps({"message": {"content": "Answer"}}).encode("utf-8"))
        with patch("local_voice.urlopen", return_value=model_response) as request_model:
            reply = local_voice.chat([{"role": "user", "content": "Explain this"}], "Source PDF text")

        self.assertEqual(reply, "Answer")
        payload = json.loads(request_model.call_args.args[0].data)
        self.assertIn("untrusted reference material", payload["messages"][0]["content"])
        self.assertIn("Source PDF text", payload["messages"][0]["content"])


if __name__ == "__main__":
    unittest.main()
