# Third-party components

Órbita's own source code is licensed under the [MIT License](LICENSE). External runtimes and model weights keep their own licenses. They are downloaded separately and are not included in the source repository.

| Component | Purpose | Upstream license and source |
| --- | --- | --- |
| Electron | Desktop window and Chromium/Node.js runtime | [MIT license](https://github.com/electron/electron/blob/main/LICENSE), [source](https://github.com/electron/electron) |
| llama.cpp | Local GGUF model inference | [MIT license](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE), [source](https://github.com/ggml-org/llama.cpp) |
| whisper.cpp | Local speech transcription | [MIT license](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE), [source](https://github.com/ggml-org/whisper.cpp) |
| Whisper models | Speech model weights used by whisper.cpp | [OpenAI Whisper MIT license](https://github.com/openai/whisper/blob/main/LICENSE), [GGML model distribution](https://huggingface.co/ggerganov/whisper.cpp) |
| Qwen2.5-Coder-1.5B-Instruct-GGUF | A small compatible coding model | [Official model card, Apache-2.0](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF), [model license](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/blob/main/LICENSE) |
| Playwright | Optional UI development tests | [Apache-2.0 license](https://github.com/microsoft/playwright/blob/main/LICENSE), [source](https://github.com/microsoft/playwright) |

Electron distributions also contain Chromium, Node.js, and other libraries with additional notices. Keep the `LICENSE` and `LICENSES.chromium.html` files from the downloaded Electron archive with any redistributed Electron binary. Keep the licenses and notices shipped with llama.cpp and whisper.cpp when redistributing their binaries. GPU runtime packages may have further component notices.

Users can import other GGUF models. Each model has its own license and usage conditions; the MIT license for Órbita does not relicense those weights. Hugging Face, GitHub, and public search providers are external services with their own terms. Órbita is an independent project and is not affiliated with those services or with Codex, Devin, Claude Code, or Cursor.

No third-party speech recording is required by the unit tests. Live dictation tests should use a recording you have permission to use, supplied with `ORBITA_SPEECH_SAMPLE`. Generated logs, test recordings, downloaded models, runtime binaries, and personal application data are excluded from the public source.
