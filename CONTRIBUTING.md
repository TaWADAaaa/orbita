# Contributing

Contributions are welcome. Keep the interface clear: one main action at a time, short messages, readable controls, and details only when they help someone make a decision.

## Local development

Use Windows 10 or 11, x64, with Node.js 20 or newer and PowerShell. Follow the [README setup steps](README.md#run-from-source), then run:

```powershell
npm test
```

The unit tests use Node's built-in test runner. Optional Electron UI tests need Playwright and, for tests that generate responses, a locally installed model. Check the test file before running it: UI tests may use the network, launch subprocesses, and create isolated temporary projects. Use a separate test profile with `ORBITA_TEST_PROFILE`; do not use someone else's personal application data or recordings as test fixtures.

For live dictation tests, set `ORBITA_SPEECH_SAMPLE` to a 16-bit, mono, 16 kHz WAV recording you have permission to use. No third-party recording is bundled.

## Changes

1. Open an issue for a substantial behavior change so its scope can be discussed.
2. Make a branch and keep each change focused.
3. Add meaningful coverage for new permission rules, file operations, network handling, or process management. For visual changes, verify the app at narrow and wide window sizes.
4. Run the relevant tests and explain the resulting behavior and validation in your pull request.

Keep English documentation and English UI strings complete. Preserve Spanish translations when changing a translated control. Never put private conversations, memory, settings, access tokens, model weights, runtime downloads, or local backups in a commit.

Permission checks belong in the backend. A model response or renderer request must not be able to increase its own access level. Treat file contents, webpages, and model output as untrusted input. Keep shell execution visibly different from confined project file tools: commands run with the user's operating-system permissions.

By submitting code, you agree to license your contribution under this repository's [MIT License](LICENSE). Disclose any third-party code and preserve its required notices. Do not submit material you cannot license for public distribution.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of posting sensitive details in a public issue.
