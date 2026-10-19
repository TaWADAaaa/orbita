# Tests

Run `npm test` for the Node.js unit and integration suite. Test fixtures use temporary directories and do not need an account, a downloaded model, or an internet connection.

Optional Electron UI checks use Playwright and an isolated application profile. Real model and voice checks require explicitly prepared local assets; see the main README and script comments. Provide your own WAV recording through `ORBITA_SPEECH_SAMPLE` for the optional voice flow.
