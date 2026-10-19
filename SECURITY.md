# Security

Órbita runs local models and local tools. It is an experimental desktop assistant, so review important changes and keep independent backups of valuable work.

## Access levels

The seven levels control when **AI tool actions need your approval**. They are not an operating-system sandbox. The app starts at level 1. Lower levels ask before actions that need a higher level; higher levels automatically approve those actions. Changes apply to the next task.

At level 6, a command can create, change, or delete files outside the selected project using your Windows account's permissions. Approving a command manually at a lower level has the same effect. Level 7 additionally approves direct file deletion. Commands do not have automatic undo. Opening a document in another application is also a level-6 action.

Direct project file tools reject unsafe paths and links and check for conflicting edits. Backups support undo for supported file edits and deletions; they are not a replacement for a full backup. Manual buttons and editor actions are actions you initiate and do not go through AI approval prompts.

## Data and network

Conversations, memory, settings, model configuration, and edit backups are stored under `%APPDATA%\Orbita Local`. These files are not encrypted by the app. Do not save passwords, API keys, or other secrets as memories. Memory can be reviewed and deleted in Settings. The AI needs level 3 to save a memory automatically and level 7 to delete one automatically; otherwise it asks.

Model inference and speech transcription run on the computer. There is no app account or telemetry. Public web searches, page reads, Hugging Face browsing, and runtime/model downloads contact their respective external servers. Search queries and requested URLs leave the computer. The model server binds to loopback with a random per-process API key.

The public-web tools reject private-network targets and constrain redirects, DNS resolution, size, and duration. They read text and do not provide authenticated browsing or an arbitrary browser-control interface. These checks do not restrict commands run in the console.

## Reporting a vulnerability

If the repository offers **Security → Report a vulnerability**, use that private reporting form. If private reporting is unavailable, open an issue asking for a private contact channel without including exploit details, private files, tokens, or personal conversations. Do not upload a full application data folder to an issue.

Include the app version, Windows version, affected tool, access level, expected behavior, and a minimal example using disposable files. Avoid running a destructive proof of concept against real projects.

This project currently maintains the latest source version. There is no guaranteed response or fix timeline.
