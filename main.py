from io import BytesIO
import time
import os
import tempfile
import shutil
from flask import Flask, jsonify, render_template, request, send_file
from pdfminer.pdfdocument import PDFEncryptionError
from pdfminer.pdfparser import PDFSyntaxError
from werkzeug.utils import secure_filename
from script import convert
from flask_cors import cross_origin
from reader import extract_document
from local_voice import VoiceServiceError, chat as local_chat, synthesize, transcribe, voice_status


app = Flask(__name__)

ALLOWED_EXTENSIONS = {'pdf'}
app.config['MAX_CONTENT_LENGTH'] = 25 * 1024 * 1024


def allowed_file(filename):
   return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def require_local_voice():
    if os.environ.get("LOCAL_VOICE_ENABLED", "").lower() not in {"1", "true", "yes"}:
        return jsonify(error="Local AI is disabled. Set LOCAL_VOICE_ENABLED=1 and restart the app to enable it."), 503
    return None


@app.route('/', methods=['GET', 'POST'])
@cross_origin()
def index():
        return render_template('index.html')


@app.route("/read_pdf", methods=['POST'])
def read_pdf():
    file = request.files.get('file')
    if not file or not file.filename:
        return jsonify(error="Choose a PDF file to read."), 400
    if not allowed_file(file.filename):
        return jsonify(error="Only PDF files can be read."), 415

    try:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = os.path.join(temporary_directory, "document.pdf")
            file.save(temporary_path)
            document = extract_document(temporary_path)
    except (OSError, ValueError, PDFEncryptionError, PDFSyntaxError):
        app.logger.exception("Could not extract text from uploaded PDF")
        return jsonify(error="We couldn't read this PDF. It may be damaged or image-only."), 422

    if not document["blocks"]:
        return jsonify(error="No readable text was found in this PDF."), 422
    return jsonify(document)


@app.route("/api/voice/chat", methods=["POST"])
def voice_chat():
    disabled_response = require_local_voice()
    if disabled_response:
        return disabled_response
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="Send a JSON conversation request."), 400
    try:
        reply = local_chat(payload.get("messages"), payload.get("documentText"))
    except VoiceServiceError as error:
        return jsonify(error=str(error)), error.status_code
    return jsonify(reply=reply)


@app.route("/api/voice/status", methods=["GET"])
def voice_configuration():
    return jsonify(voice_status())


@app.route("/api/voice/speech", methods=["POST"])
def voice_speech():
    disabled_response = require_local_voice()
    if disabled_response:
        return disabled_response
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="Send JSON containing the text to speak."), 400
    try:
        audio = synthesize(
            payload.get("text"),
            voice=payload.get("voice"),
            naturalness=payload.get("naturalness", 50),
        )
    except VoiceServiceError as error:
        return jsonify(error=str(error)), error.status_code
    return send_file(BytesIO(audio), mimetype="audio/wav", download_name="reply.wav")


@app.route("/api/voice/transcribe", methods=["POST"])
def voice_transcribe():
    disabled_response = require_local_voice()
    if disabled_response:
        return disabled_response
    audio_file = request.files.get("audio")
    if not audio_file or not audio_file.filename:
        return jsonify(error="Record a voice message first."), 400

    extension_by_type = {
        "audio/webm": ".webm",
        "audio/ogg": ".ogg",
        "audio/mp4": ".mp4",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
    }
    extension = extension_by_type.get(audio_file.mimetype)
    if not extension:
        return jsonify(error="This browser's recording format isn't supported."), 415

    audio = audio_file.stream.read(15 * 1024 * 1024 + 1)
    if len(audio) > 15 * 1024 * 1024:
        return jsonify(error="Voice recordings must be 15 MB or smaller."), 413
    if not audio:
        return jsonify(error="The recording was empty. Try again."), 400

    try:
        with tempfile.TemporaryDirectory() as temporary_directory:
            audio_path = os.path.join(temporary_directory, f"recording{extension}")
            with open(audio_path, "wb") as saved_audio:
                saved_audio.write(audio)
            transcript = transcribe(audio_path)
    except VoiceServiceError as error:
        return jsonify(error=str(error)), error.status_code
    return jsonify(transcript=transcript)


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify(error="Uploads must be 25 MB or smaller."), 413


@app.route('/Behind_the_making', methods=['GET', 'POST'])
def behind_the_making():
    return render_template('Profile.html')


@app.route('/Terms_of_service', methods=['GET', 'POST'])
def Terms_of_service():
    return render_template('terms.html')


@app.route("/convert_pdf", methods=['GET', 'POST'])
def convert_pdf():
    if request.method == 'POST':
        file = request.files['file']
        if file and allowed_file(file.filename):
            filename = secure_filename(file.filename)
            timestr = time.strftime("%Y%m%d_%H%M%S")

            save_location = os.path.join('uploads', filename)
            save_location = save_location.replace(' ', '_')
            save_location = save_location.replace('\\', '/')
            save_location = save_location.replace('.pdf', '_listenToPdf' + timestr + '.pdf')
            file.save(save_location)

            convert(save_location)

            save_location = save_location.replace('pdf', 'mp3')
            save_location = save_location.replace('uploads', 'downloads')
            file_path = save_location
            file_handle = open(file_path, 'r')
            file_handle.close()

            try:
                return send_file(file_path, as_attachment=True)
            finally:
                folder = 'downloads'
                for filename in os.listdir(folder):
                    file_path = os.path.join(folder, filename)
                    try:
                        if os.path.isfile(file_path) or os.path.islink(file_path):
                            os.unlink(file_path)
                        elif os.path.isdir(file_path):
                            shutil.rmtree(file_path)
                    except Exception as e:
                        print('failed to delete %s. Reason: %s' % (file_path, e))
                print('Audio deleted!')
                folder2 = 'uploads'
                for filename in os.listdir(folder2):
                    file_path = os.path.join(folder2, filename)
                    try:
                        if os.path.isfile(file_path) or os.path.islink(file_path):
                            os.unlink(file_path)
                        elif os.path.isdir(file_path):
                            shutil.rmtree(file_path)
                    except Exception as e:
                        print('failed to delete %s. Reason: %s' % (file_path, e))
                print('Pdf deleted!')


    return render_template('wrongfile.html')


if __name__ == "__main__":
    app.run()
