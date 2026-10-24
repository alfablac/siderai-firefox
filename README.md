# Graphite Sider: AI Sidebar (BYO API)

Graphite Sider is an AI sidebar for Firefox that runs on your own API keys. You add a provider, paste a key, and the sidebar talks to that provider directly. OpenAI, Anthropic, OpenRouter, Groq, DeepSeek, Together, Fireworks, Mistral, and xAI all work, and so does any other gateway that speaks the OpenAI or Anthropic API shape. If you would rather not send anything out at all, point it at Ollama or LM Studio on localhost and the key becomes optional.

There is no account to create and nothing to top up, because there is no server on our side to hold one. Your keys and settings live in Firefox local storage on your machine. The only address the extension calls is the base URL you typed into Settings.

## Screenshots

The pictures below are renders of the extension interface with example text typed in. No real pages, keys, or accounts appear in them. Click a thumbnail to see it at full size.

| Preview | What it shows |
| --- | --- |
| [![Sidebar chat with a YouTube answer and clickable timestamps](screenshots/01-sidebar-chat.png)](screenshots/01-sidebar-chat.png) | Sidebar chat. Timestamps in an answer are buttons that seek the player. |
| [![Sidebar tools grid with the Translate tool open](screenshots/02-sidebar-tools.png)](screenshots/02-sidebar-tools.png) | The tools grid, with Translate open on Portuguese (Brazil). |
| [![YouTube summary panel with tables and timestamp buttons](screenshots/03-youtube-panel.png)](screenshots/03-youtube-panel.png) | The summary panel that sits under a YouTube video. |
| [![Search answer card in the right rail next to results](screenshots/04-search-answer.png)](screenshots/04-search-answer.png) | The answer card in the right rail of a search results page. It stays empty until you press Generate. |
| [![Settings page with provider cards](screenshots/05-settings.png)](screenshots/05-settings.png) | Settings, where providers, keys, and models live. The key field here is filler text. |
| [![Selection toolbar and result card on a page](screenshots/06-selection-tools.png)](screenshots/06-selection-tools.png) | The toolbar that appears when you select text, and the card that holds the answer. |

## What it does

Chat in the sidebar and watch answers stream in. You can keep several providers on file and send one prompt to a few of them at once to compare replies side by side.

Ask about the page you are reading. The sidebar pulls the readable text out of the current tab and summarizes it, or answers questions about it. Select some text first and the same tools work on the selection: summarize, explain, translate, rewrite, fix grammar, or ask something of your own.

Summarize YouTube videos from their captions. The summaries follow a structured format with headings and themes, and every timestamp in the answer is clickable. Click one and the player jumps to that moment. Long videos are the point: a 45 minute video takes a minute to scan instead of the whole afternoon. Chapters and subtitle translation run off the same captions.

Get writing help where you already write. Select a draft on any page and rewrite it, shorten it, expand it, change the tone, or check the grammar. A small icon appears next to text fields and opens the same tools in a menu, and the selection toolbar that pops up when you highlight text can be dragged out of the way by its logo.

Read an answer next to your search results. On Google, Bing, and DuckDuckGo, the extension can draft an answer in the right rail using your model, in the same dark panel the search page uses. It sits there idle until you press Generate, so ordinary searches cost you nothing.

Translate with your own language list. The picker offers the languages you keep in Settings, one per line, so you can ask for Brazilian Portuguese instead of Portugal Portuguese, or add a variant you actually read. Image generation uses a separate image model when your gateway supports one, so your chat model and image model never have to be the same.

Prompts are editable. Pick a built-in prompt from the dropdown in Settings, change the wording in the editor, and that version is what runs. Custom prompts you save for yourself live in the same place. YouTube summaries use your edited wording too, not a hidden copy.

## Install

Firefox 140 or newer is required. The extension declares what data it can send (Settings calls it data collection permissions), and Firefox only shows that consent prompt on 140 and up.

From AMO: search for Graphite Sider on addons.mozilla.org, or open the listing at https://addons.mozilla.org/en-US/firefox/addon/graphite-sider-ai-sidebar-byo-/

From source: load the extension as a temporary add-on.

1. Clone this repo.
2. Open `about:debugging` in Firefox, choose This Firefox, then Load Temporary Add-on.
3. Pick `extension/manifest.json`.

Temporary add-ons vanish when Firefox restarts, so for everyday use install the signed build from AMO.

To package an XPI yourself you need a zip tool. Put the contents of `extension/` in a zip with `manifest.json` at the root and rename it to `.xpi`.

## Setup

Open Settings from the sidebar gear or from `about:addons`. Add a provider from a preset, or choose Custom and enter a base URL, then paste your key. Press Test Connection. If it passes, open the sidebar with Ctrl+Shift+Y and start asking.

Two optional fields are worth knowing about. Image model is separate from the chat model and only matters if your gateway can generate images. Active model override replaces the provider default for chat without editing the provider.

For a local model, run Ollama with `OLLAMA_ORIGINS=*` so the extension origin is allowed, add the Ollama preset, and leave the key blank.

## Privacy

Keys stay in `browser.storage.local`. They are sent only as an authorization header to the provider you configured. Page text, selections, drafts, captions, and search queries go to that same provider, and only when you run an action: Summarize, Translate, Generate, and so on. Nothing runs in the background and nothing phones home. Pick Ollama or LM Studio and all of it stays on your machine.

The Settings export file contains your keys in plain text. That is what makes it useful for moving to another machine, and it is also why you should keep it somewhere private.

The extension never reads another service's session or cookies. It calls official APIs with keys you paste in.

## What it does not do

There is no sync and no usage dashboard, because there is no server. Settings move between machines only when you export and import them yourself. There are no accounts, plans, or credits either. Your provider bills you, and it bills you for exactly the calls you made.

Hosted agent features that need a backend of their own are out of scope, along with anything that would automate your desktop.

## Layout

- `extension/manifest.json`: MV2 manifest, sidebar action, content scripts, permissions, data collection declaration
- `extension/background.js`: message router, context menus, streaming chat port
- `extension/lib/`: providers, storage, prompts, YouTube transcript and PDF helpers
- `extension/sidebar/`: the sidebar panel
- `extension/content/`: page toolbar and cards, the YouTube panel, the search answer card
- `extension/options/`: the Settings page

No build step and no dependencies. The files in `extension/` are the source, exactly as shipped.

## Keyboard shortcuts

- `Ctrl+Shift+Y`: open or close the sidebar
- `Alt+Shift+S`: summarize the current page
- `Alt+Shift+T`: translate the current selection

## License

MIT. See LICENSE.
