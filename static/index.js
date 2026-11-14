const form = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const dropZone = document.getElementById("drop-zone");
const uploadStatus = document.getElementById("upload-status");
const welcome = document.getElementById("welcome");
const reader = document.getElementById("reader");
const player = document.getElementById("player");
const documentText = document.getElementById("document-text");
const outlineList = document.getElementById("outline-list");
const playButton = document.getElementById("play-button");
const progressSlider = document.getElementById("progress-slider");
const speedSlider = document.getElementById("speed-slider");
const voiceSelect = document.getElementById("voice-select");
const naturalnessSlider = document.getElementById("naturalness-slider");
const toast = document.getElementById("toast");
const companionPanel = document.getElementById("companion-panel");
const conversation = document.getElementById("conversation");
const conversationForm = document.getElementById("conversation-form");
const messageInput = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const recordButton = document.getElementById("record-button");
const companionStatus = document.getElementById("companion-status");
const hasRecorder = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
const MAX_CONTEXT_CHARS = 100_000;

let blocks = [];
let sections = [];
let textIndexes = [];
let currentIndex = -1;
let playing = false;
let finished = false;
let playbackVersion = 0;
let currentAudio = null;
let audioObjectUrl = null;
let currentAudioKind = null;
let speechReady = false;
let localAIEnabled = false;
let transcriptionReady = false;
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
let conversationMessages = [];
let conversationVersion = 0;
let estimatedSeconds = 0;
let totalCharacters = 0;
let toastTimeout;

function readVoicePreferences() {
    try {
        const preferences = JSON.parse(localStorage.getItem("listentopdf-voice-preferences") || "{}");
        if (typeof preferences.voice === "string") voiceSelect.dataset.savedVoice = preferences.voice;
        if (Number.isInteger(preferences.naturalness) && preferences.naturalness >= 0 && preferences.naturalness <= 100) {
            naturalnessSlider.value = String(preferences.naturalness);
        }
    } catch {
        // Use the default controls when local storage is unavailable or invalid.
    }
}

function saveVoicePreferences() {
    try {
        localStorage.setItem("listentopdf-voice-preferences", JSON.stringify({
            voice: voiceSelect.value,
            naturalness: Number(naturalnessSlider.value)
        }));
    } catch {
        // Voice controls still work for this session if preferences cannot be saved.
    }
}

function updateNaturalnessLabel() {
    const value = Number(naturalnessSlider.value);
    const label = value < 30 ? "Softer" : value > 70 ? "More variation" : "Balanced";
    document.getElementById("naturalness-value").value = label;
}

readVoicePreferences();
updateNaturalnessLabel();

function updateRecordingAvailability() {
    recordButton.disabled = !hasRecorder || !localAIEnabled || !transcriptionReady;
}

updateRecordingAvailability();

function showError(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 5000);
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "--:--";
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainder}`;
}

function updateUploadStatus(message) {
    uploadStatus.textContent = message;
}

function setCompanionStatus(message, isError = false) {
    companionStatus.textContent = message;
    companionStatus.classList.toggle("error", isError);
}

async function loadFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
        showError("Choose a PDF file to start listening.");
        return;
    }

    updateUploadStatus(`Preparing ${file.name}…`);
    const data = new FormData();
    data.append("file", file);

    try {
        const response = await fetch("/read_pdf", { method: "POST", body: data });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "We couldn't read this PDF.");
        openDocument(file.name, result);
    } catch (error) {
        showError(error.message || "We couldn't read this PDF. Please try another file.");
        updateUploadStatus("Try another text-based PDF.");
    }
}

function openDocument(name, payload) {
    blocks = payload.blocks || [];
    sections = payload.sections || [];
    currentIndex = nextTextIndex(0);
    playing = false;
    finished = false;
    playbackVersion++;
    conversationVersion++;
    stopAudio();
    conversationMessages = [];
    conversation.replaceChildren();
    const welcomeMessage = document.createElement("p");
    welcomeMessage.className = "conversation-welcome";
    welcomeMessage.textContent = "Hi! I can explain a section, answer questions about this PDF, or read a passage with you. What would you like to explore?";
    conversation.append(welcomeMessage);
    textIndexes = [];
    totalCharacters = 0;

    documentText.replaceChildren();
    blocks.forEach((block, index) => {
        if (block.kind === "heading") {
            const heading = document.createElement("h3");
            heading.className = "text-heading";
            heading.id = `reading-block-${index}`;
            heading.textContent = block.text;
            documentText.append(heading);
            return;
        }

        const paragraph = document.createElement("p");
        paragraph.className = "text-block";
        paragraph.id = `reading-block-${index}`;
        paragraph.textContent = block.text;
        documentText.append(paragraph);
        textIndexes.push(index);
        totalCharacters += block.text.length + 1;
    });

    renderOutline();
    const wordCount = blocks
        .filter((block) => block.kind === "text")
        .reduce((count, block) => count + block.text.split(/\s+/).length, 0);
    estimatedSeconds = wordCount / (170 * Number(speedSlider.value) / 60);

    document.getElementById("document-name").textContent = name;
    document.getElementById("document-meta").textContent = `${wordCount.toLocaleString()} words · about ${formatTime(estimatedSeconds)}`;
    document.getElementById("reading-title").textContent = name.replace(/\.pdf$/i, "");
    document.getElementById("player-name").textContent = name;
    document.getElementById("player-status").textContent = speechReady
        ? "Ready with your local AI voice"
        : "Configure a local Piper voice to read aloud";
    welcome.classList.add("hidden");
    reader.classList.remove("hidden");
    player.classList.remove("hidden");

    updateProgress();
    document.getElementById("reading-title").focus?.();
}

function renderOutline() {
    outlineList.replaceChildren();
    sections.forEach((section, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "outline-item";
        button.textContent = section.title;
        button.addEventListener("click", () => {
            const start = nextTextIndex(section.start);
            if (start >= 0) beginPlayback(start);
        });
        outlineList.append(button);
    });
}

function nextTextIndex(index) {
    for (let cursor = Math.max(0, index); cursor < blocks.length; cursor++) {
        if (blocks[cursor].kind === "text") return cursor;
    }
    return -1;
}

function previousTextIndex(index) {
    for (let cursor = Math.min(index - 1, blocks.length - 1); cursor >= 0; cursor--) {
        if (blocks[cursor].kind === "text") return cursor;
    }
    return -1;
}

function currentSection() {
    if (currentIndex < 0) return 0;
    return Math.max(0, blocks[currentIndex].section || 0);
}

function updateProgress(completed = finished) {
    const indexPosition = textIndexes.indexOf(currentIndex);
    const completedCharacters = indexPosition < 0
        ? 0
        : textIndexes.slice(0, indexPosition).reduce((sum, index) => sum + blocks[index].text.length + 1, 0);
    const progress = completed ? 100 : totalCharacters ? Math.min(100, Math.round(completedCharacters / totalCharacters * 100)) : 0;
    const elapsed = estimatedSeconds * progress / 100;

    progressSlider.value = progress;
    document.getElementById("reading-progress").style.width = `${progress}%`;
    document.getElementById("reading-progress-label").textContent = `${progress}% complete`;
    document.getElementById("elapsed-time").textContent = formatTime(elapsed);
    document.getElementById("remaining-time").textContent = `-${formatTime(Math.max(0, estimatedSeconds - elapsed))}`;
    document.getElementById("current-section-label").textContent = sections[currentSection()]?.title || "NOW READING";

    document.querySelectorAll(".text-block.active").forEach((element) => element.classList.remove("active"));
    document.querySelectorAll(".outline-item.active").forEach((element) => element.classList.remove("active"));
    if (currentIndex < 0) return;

    document.getElementById(`reading-block-${currentIndex}`)?.classList.add("active");
    outlineList.children[currentSection()]?.classList.add("active");
    document.getElementById(`reading-block-${currentIndex}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function updatePlayButton() {
    playButton.textContent = playing ? "Ⅱ" : "▶";
    playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
    if (playing) {
        document.getElementById("player-status").textContent = currentAudioKind === "reply"
            ? "Speaking companion reply…"
            : "Reading aloud";
    } else {
        document.getElementById("player-status").textContent = finished ? "Finished" : "Paused";
    }
}

function stopAudio() {
    if (currentAudio) {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
        currentAudio.removeAttribute("src");
        currentAudio.load();
        currentAudio = null;
    }
    currentAudioKind = null;
    if (audioObjectUrl) {
        URL.revokeObjectURL(audioObjectUrl);
        audioObjectUrl = null;
    }
}

async function playLocalSpeech(text, version, onEnded, kind = "reader") {
    const response = await fetch("/api/voice/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            text,
            voice: voiceSelect.value || undefined,
            naturalness: Number(naturalnessSlider.value)
        })
    });
    if (!response.ok) {
        let error = "Local speech generation failed.";
        try {
            error = (await response.json()).error || error;
        } catch {
            // Use the generic error when the server response isn't JSON.
        }
        throw new Error(error);
    }

    const audioBlob = await response.blob();
    if (version !== playbackVersion) return;

    stopAudio();
    audioObjectUrl = URL.createObjectURL(audioBlob);
    currentAudio = new Audio(audioObjectUrl);
    currentAudioKind = kind;
    currentAudio.playbackRate = Number(speedSlider.value);
    currentAudio.onended = () => {
        if (version !== playbackVersion) return;
        stopAudio();
        onEnded();
    };
    currentAudio.onerror = () => {
        if (version !== playbackVersion) return;
        stopAudio();
        playing = false;
        updatePlayButton();
        document.getElementById("player-status").textContent = "Local audio could not be played";
        showError("The generated audio could not be played in this browser.");
    };
    await currentAudio.play();
}

function beginPlayback(index = currentIndex) {
    const nextIndex = nextTextIndex(index);
    if (nextIndex < 0) return;
    currentIndex = nextIndex;
    finished = false;
    updateProgress();

    if (!speechReady) {
        document.getElementById("player-status").textContent = "Configure and enable the local AI voice";
        showError("Enable local AI and configure a Piper voice in the README setup instructions.");
        return;
    }

    playbackVersion++;
    stopAudio();
    playing = true;
    document.getElementById("player-status").textContent = "Preparing local voice…";
    updatePlayButton();
    speakCurrent(playbackVersion);
}

async function speakCurrent(version) {
    if (version !== playbackVersion || currentIndex < 0) return;
    document.getElementById("player-status").textContent = "Generating local speech…";
    try {
        await playLocalSpeech(blocks[currentIndex].text, version, () => {
            currentIndex = nextTextIndex(currentIndex + 1);
            if (currentIndex < 0) {
                playing = false;
                currentIndex = textIndexes[textIndexes.length - 1] ?? -1;
                finished = true;
                updateProgress(true);
                updatePlayButton();
                return;
            }
            updateProgress();
            speakCurrent(version);
        });
        if (version === playbackVersion && playing && currentAudio) {
            document.getElementById("player-status").textContent = "Reading aloud with Piper";
        }
    } catch (error) {
        if (version !== playbackVersion) return;
        playing = false;
        updatePlayButton();
        document.getElementById("player-status").textContent = "Local voice unavailable";
        showError(error.message);
    }
}

async function speakReply(text) {
    playbackVersion++;
    stopAudio();
    currentAudioKind = "reply";
    playing = true;
    updatePlayButton();
    const version = playbackVersion;
    document.getElementById("player-status").textContent = "Speaking companion reply…";
    try {
        await playLocalSpeech(text, version, () => {
            playing = false;
            updatePlayButton();
            document.getElementById("player-status").textContent = "Reply finished";
            setCompanionStatus("Ready for another question.");
        }, "reply");
        if (version === playbackVersion && currentAudio) setCompanionStatus("Reply is playing through your local voice.");
        return true;
    } catch (error) {
        if (version !== playbackVersion) return;
        playing = false;
        updatePlayButton();
        document.getElementById("player-status").textContent = "Local voice unavailable";
        setCompanionStatus(error.message, true);
        showError(error.message);
        return false;
    }
}

async function loadVoiceStatus() {
    try {
        const response = await fetch("/api/voice/status");
        if (!response.ok) throw new Error("Unable to check local voice setup.");
        const status = await response.json();
        localAIEnabled = status.enabled;
        speechReady = localAIEnabled && status.speech_ready;
        transcriptionReady = localAIEnabled && status.transcription_ready;
        updateRecordingAvailability();
        voiceSelect.replaceChildren();
        for (const voice of status.available_voices || []) {
            const option = document.createElement("option");
            option.value = voice.id;
            option.textContent = voice.label;
            voiceSelect.append(option);
        }
        const preferredVoice = voiceSelect.dataset.savedVoice;
        const selectedVoice = (status.available_voices || []).some((voice) => voice.id === preferredVoice)
            ? preferredVoice
            : `${status.speech_voice}.onnx`;
        if (selectedVoice && Array.from(voiceSelect.options).some((option) => option.value === selectedVoice)) {
            voiceSelect.value = selectedVoice;
        }
        voiceSelect.disabled = !speechReady || voiceSelect.options.length < 2;
        if (!status.available_voices?.length) {
            const option = document.createElement("option");
            option.textContent = !status.enabled ? "Local AI disabled" : "Piper voice not configured";
            voiceSelect.append(option);
        }
        setCompanionStatus(
            !status.enabled
                ? "Local AI is disabled. See the README to enable your local models."
                : `Local models: ${status.ollama_model} · ${status.transcription_ready ? "Whisper ready" : "Whisper not installed"} · ${speechReady ? "Piper ready" : "Piper voice not configured"}`
        );
    } catch (error) {
        updateRecordingAvailability();
        voiceSelect.replaceChildren(new Option("Local setup unavailable", ""));
        voiceSelect.disabled = true;
        setCompanionStatus(error.message, true);
    }
}

function addConversationMessage(role, text) {
    const message = document.createElement("div");
    message.className = `conversation-message ${role}`;
    const content = document.createElement("p");
    content.textContent = text;
    message.append(content);

    if (role === "assistant") {
        const replay = document.createElement("button");
        replay.className = "message-play";
        replay.type = "button";
        replay.textContent = "▶ Play reply";
        replay.addEventListener("click", () => speakReply(text));
        message.append(replay);
    }

    conversation.append(message);
    conversation.scrollTop = conversation.scrollHeight;
}

function getConversationDocumentContext() {
    const formatBlocks = (source) => source
        .map((block) => block.kind === "heading" ? `\n${block.text}\n` : block.text)
        .join("\n");
    const fullDocument = formatBlocks(blocks);
    if (fullDocument.length <= MAX_CONTEXT_CHARS) return { text: fullDocument, limited: false };

    const sectionBlocks = blocks.filter((block) => block.section === currentSection());
    const sectionText = formatBlocks(sectionBlocks);
    if (sectionText.length <= MAX_CONTEXT_CHARS) return { text: sectionText, limited: true };

    const sectionTextBlocks = sectionBlocks
        .map((block, index) => ({ block, index }))
        .filter(({ block }) => block.kind === "text");
    const activePosition = Math.max(
        0,
        sectionTextBlocks.findIndex(({ block }) => block === blocks[currentIndex])
    );
    let radius = 30;
    let excerpt = "";
    while (radius > 0) {
        const excerptBlocks = sectionTextBlocks
            .slice(Math.max(0, activePosition - radius), activePosition + radius + 1)
            .map(({ block }) => block);
        excerpt = formatBlocks(excerptBlocks);
        if (excerpt.length <= MAX_CONTEXT_CHARS) break;
        radius = Math.floor(radius / 2);
    }
    return {
        text: `[Excerpt from the section you're reading in a longer PDF]\n${excerpt.slice(0, MAX_CONTEXT_CHARS)}`,
        limited: true
    };
}

async function sendConversation(text) {
    const message = text.trim();
    if (!message) return;

    const requestVersion = conversationVersion;
    conversation.querySelector(".conversation-welcome")?.remove();
    conversationMessages.push({ role: "user", content: message });
    conversationMessages = conversationMessages.slice(-20);
    addConversationMessage("user", message);
    messageInput.value = "";
    sendButton.disabled = true;
    recordButton.disabled = true;
    playbackVersion++;
    stopAudio();
    playing = false;
    updatePlayButton();
    setCompanionStatus("Thinking with your local model…");

    try {
        const context = getConversationDocumentContext();
        if (context.limited) setCompanionStatus("Long PDF: using the section you're reading as context…");
        const response = await fetch("/api/voice/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                documentText: context.text,
                messages: conversationMessages
            })
        });
        const result = await response.json();
        if (requestVersion !== conversationVersion) return;
        if (!response.ok) throw new Error(result.error || "The local reading companion couldn't reply.");

        conversationMessages.push({ role: "assistant", content: result.reply });
        conversationMessages = conversationMessages.slice(-20);
        addConversationMessage("assistant", result.reply);
        setCompanionStatus("Speaking with your local Piper voice…");
        const speechStarted = await speakReply(result.reply);
        if (speechStarted && !currentAudio) setCompanionStatus("Ready for another question.");
    } catch (error) {
        setCompanionStatus(error.message || "The local reading companion couldn't reply.", true);
        showError(error.message || "The local reading companion couldn't reply.");
    } finally {
        sendButton.disabled = false;
        updateRecordingAvailability();
    }
}

async function transcribeRecording(blob) {
    const data = new FormData();
    data.append("audio", blob, "voice-message.webm");
    setCompanionStatus("Transcribing on this computer…");
    recordButton.disabled = true;

    try {
        const response = await fetch("/api/voice/transcribe", { method: "POST", body: data });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Couldn't transcribe that recording.");
        await sendConversation(result.transcript);
    } catch (error) {
        setCompanionStatus(error.message || "Couldn't transcribe that recording.", true);
        showError(error.message || "Couldn't transcribe that recording.");
        updateRecordingAvailability();
    }
}

async function startRecording() {
    if (!hasRecorder || !localAIEnabled || !transcriptionReady) {
        showError("Local microphone transcription isn't ready. Install faster-whisper and enable local AI.");
        return;
    }

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
            .find((type) => MediaRecorder.isTypeSupported(type));
        mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recordedChunks = [];
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size) recordedChunks.push(event.data);
        };
        mediaRecorder.onstop = () => {
            stream.getTracks().forEach((track) => track.stop());
            isRecording = false;
            recordButton.classList.remove("recording");
            recordButton.textContent = "●";
            recordButton.setAttribute("aria-label", "Record a voice message");
            recordButton.title = "Record a voice message";
            const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
            if (blob.size) transcribeRecording(blob);
            else setCompanionStatus("The recording was empty. Try again.", true);
        };
        mediaRecorder.start();
        isRecording = true;
        recordButton.classList.add("recording");
        recordButton.textContent = "■";
        recordButton.setAttribute("aria-label", "Stop recording");
        recordButton.title = "Stop recording";
        setCompanionStatus("Listening… select stop when you're done.");
    } catch (error) {
        stream?.getTracks().forEach((track) => track.stop());
        setCompanionStatus("Microphone access failed. Allow microphone access and try again.", true);
        showError(error.message || "Microphone access failed.");
    }
}

form.addEventListener("submit", (event) => event.preventDefault());
fileInput.addEventListener("change", () => loadFile(fileInput.files[0]));
document.getElementById("change-file").addEventListener("click", () => fileInput.click());
document.getElementById("companion-toggle").addEventListener("click", (event) => {
    const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
    event.currentTarget.setAttribute("aria-expanded", String(!expanded));
    companionPanel.classList.toggle("hidden", expanded);
    if (!expanded) messageInput.focus();
});
document.getElementById("clear-conversation").addEventListener("click", () => {
    conversationVersion++;
    playbackVersion++;
    stopAudio();
    playing = false;
    updatePlayButton();
    conversationMessages = [];
    conversation.replaceChildren();
    const welcomeMessage = document.createElement("p");
    welcomeMessage.className = "conversation-welcome";
    welcomeMessage.textContent = "Hi! I can explain a section, answer questions about this PDF, or read a passage with you. What would you like to explore?";
    conversation.append(welcomeMessage);
    setCompanionStatus("Conversation cleared.");
});
conversationForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendConversation(messageInput.value);
});
messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        conversationForm.requestSubmit();
    }
});
recordButton.addEventListener("click", () => {
    if (isRecording) mediaRecorder.stop();
    else startRecording();
});

for (const eventName of ["dragenter", "dragover"]) {
    dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.add("drag-over");
    });
}
for (const eventName of ["dragleave", "drop"]) {
    dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.remove("drag-over");
    });
}
dropZone.addEventListener("drop", (event) => loadFile(event.dataTransfer.files[0]));

playButton.addEventListener("click", () => {
    if (playing) {
        if (currentAudio) currentAudio.pause();
        else {
            playbackVersion++;
            stopAudio();
        }
        playing = false;
        updatePlayButton();
    } else if (currentAudio) {
        currentAudio.play().catch((error) => showError(error.message));
        playing = true;
        updatePlayButton();
    } else {
        beginPlayback(finished ? nextTextIndex(0) : currentIndex);
    }
});
document.getElementById("previous-button").addEventListener("click", () => {
    const previous = previousTextIndex(currentIndex);
    if (previous >= 0) beginPlayback(previous);
});
document.getElementById("next-button").addEventListener("click", () => {
    const next = nextTextIndex(currentIndex + 1);
    if (next >= 0) beginPlayback(next);
});
progressSlider.addEventListener("change", () => {
    const target = Math.min(textIndexes.length - 1, Math.floor(Number(progressSlider.value) / 100 * textIndexes.length));
    const wasPlaying = playing;
    playbackVersion++;
    stopAudio();
    currentIndex = textIndexes[Math.max(0, target)] ?? -1;
    playing = false;
    finished = false;
    updateProgress();
    updatePlayButton();
    if (wasPlaying) beginPlayback(currentIndex);
});
speedSlider.addEventListener("input", () => {
    document.getElementById("speed-value").value = `${Number(speedSlider.value).toFixed(1)}×`;
    if (currentAudio) currentAudio.playbackRate = Number(speedSlider.value);
    if (blocks.length) {
        const words = blocks.filter((block) => block.kind === "text").reduce((sum, block) => sum + block.text.split(/\s+/).length, 0);
        estimatedSeconds = words / (170 * Number(speedSlider.value) / 60);
        document.getElementById("document-meta").textContent = `${words.toLocaleString()} words · about ${formatTime(estimatedSeconds)}`;
        updateProgress();
    }
});
voiceSelect.addEventListener("change", () => {
    saveVoicePreferences();
    if (playing && currentIndex >= 0 && currentAudioKind === "reader") beginPlayback(currentIndex);
});
naturalnessSlider.addEventListener("input", updateNaturalnessLabel);
naturalnessSlider.addEventListener("change", () => {
    saveVoicePreferences();
    if (playing && currentIndex >= 0 && currentAudioKind === "reader") beginPlayback(currentIndex);
});
loadVoiceStatus();
