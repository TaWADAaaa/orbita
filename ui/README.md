# Desktop interface

The renderer uses plain HTML, CSS, and JavaScript. `app.js` handles chat, `workspace.js` provides the file editor, console and web panels, and `workflow.js` handles the message queue, voice capture, and memory controls.

`i18n.js` contains English and Spanish interface translations. Electron's sandboxed preload bridge in the repository root is the renderer's only connection to local services.
