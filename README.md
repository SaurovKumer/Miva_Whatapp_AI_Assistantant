# 🎀 Miva — Personal WhatsApp AI Assistant

Miva is a personal WhatsApp AI assistant built with **Node.js**, **whatsapp-web.js**, and the **Google Gemini API**.

Miva replies only when it is called with `@miva`. It also has an optional `@miva_skill` route that can send advanced tasks to a locally running Hermes-compatible AI gateway.

## Features

- Responds to `@miva <message>` using Gemini.
- Supports a configurable Gemini fallback model chain.
- Handles short questions and longer problem-solving requests.
- Can use supported incoming WhatsApp media as context for Gemini.
- Can read quoted-message context.
- Includes owner-only shutdown and wake-up commands for individual chats.
- Saves WhatsApp authentication locally with `LocalAuth`, so QR login normally does not need to be repeated after every restart.
- Optional `@miva_skill` command for a Hermes-compatible local gateway.
- Can run locally or continuously on a VPS with PM2.

## Project Structure

This GitHub version intentionally contains only four files:

```text
miva-bot/
├── bot.js          # Main Miva bot code
├── package.json    # Node.js dependencies and scripts
├── .env.example    # Example environment configuration
└── README.md       # Project documentation
```

Runtime/private files such as `.env`, `node_modules/`, `.wwebjs_auth/`, and `shutdown.json` are **not included** and should not be uploaded to GitHub.

## Requirements

Before running Miva, you need:

- **Node.js 20 or newer**
- **npm**
- A WhatsApp account
- A **Google Gemini API key**
- Internet access
- Optional: a Hermes-compatible local gateway for `@miva_skill`

## Installation

Clone or download the repository, then open a terminal inside the project folder.

Install the dependencies:

```bash
npm install
```

## Environment Setup

The repository contains `.env.example` only.

Create your own private `.env` file from it.

### Linux / macOS

```bash
cp .env.example .env
```

### Windows Command Prompt

```cmd
copy .env.example .env
```

Then edit `.env` and add your real values.

Example:

```env
GEMINI_API_KEY=your_real_gemini_api_key
OWNER_NUMBER=8801XXXXXXXXX

GEMINI_MODELS=gemini-3.8-flash,gemini-3.5-flash-lite

GEMINI_REQUEST_TIMEOUT_MS=25000
GEMINI_PRIMARY_COOLDOWN_MS=60000
GEMINI_NOT_FOUND_COOLDOWN_MS=600000

HERMES_API_KEY=your_hermes_gateway_key
HERMES_API_URL=http://127.0.0.1:8642/v1/chat/completions
HERMES_MODEL=hermes-agent
HERMES_TIMEOUT_MS=300000
```

### Important

Never upload your real `.env` file to GitHub. It can contain private API keys and your owner phone number.

Because this minimal repository does not include a `.gitignore`, make sure you upload or commit **only the four project files listed above**.

## Run Miva

Start the bot with:

```bash
npm start
```

You can also run it directly:

```bash
node bot.js
```

On the first run, a WhatsApp QR code will appear in the terminal. Scan it from WhatsApp to authenticate the bot.

After successful login, `whatsapp-web.js` creates a `.wwebjs_auth/` directory locally to keep the session.

Do **not** upload `.wwebjs_auth/` to GitHub because it contains private WhatsApp authentication data.

## Miva Commands

| Command | Description |
| --- | --- |
| `@miva <message>` | Send a normal request to Gemini |
| `@miva_skill <task>` | Send an advanced task to the optional Hermes gateway |
| `@miva_shutdown` | Owner only: disable Miva permanently in the current chat |
| `@miva_shutdown_for_12_hours` | Owner only: disable Miva in the current chat for 12 hours |
| `@miva_shutdown_for_<number>_hours` | Owner only: disable Miva for a custom number of hours |
| `@miva_wakeup` | Owner only: enable Miva again in the current chat |

The owner is identified using the `OWNER_NUMBER` value from `.env` or messages sent from the bot's own WhatsApp account.

## Gemini Configuration

`GEMINI_MODELS` contains a comma-separated fallback chain.

Example:

```env
GEMINI_MODELS=gemini-3.8-flash,gemini-3.5-flash-lite
```

If the first configured model temporarily fails, Miva can try the next configured model according to the fallback logic in `bot.js`.

You can change the model names in `.env` without changing the main bot code.

## Hermes Support — Optional

Hermes is **not required** for normal `@miva` messages.

It is only needed when you use:

```text
@miva_skill <task>
```

For this feature, the configured Hermes gateway must be running and reachable through:

```env
HERMES_API_URL=http://127.0.0.1:8642/v1/chat/completions
```

Miva sends an OpenAI-style chat-completions request to that endpoint using `HERMES_API_KEY` for authorization.

If you do not use Hermes, you can ignore the Hermes variables and simply avoid `@miva_skill`.

## Running on a VPS with PM2

PM2 is optional. It is **not included** as a project dependency.

Install it globally on your server:

```bash
npm install -g pm2
```

Start Miva:

```bash
pm2 start bot.js --name miva-bot
```

Useful PM2 commands:

```bash
pm2 logs miva-bot
pm2 restart miva-bot
pm2 stop miva-bot
pm2 status
```

Save the current PM2 process list:

```bash
pm2 save
```

For automatic startup after a VPS reboot:

```bash
pm2 startup
```

Then run the command PM2 prints in the terminal and run `pm2 save` again.

## Files Created When the Bot Runs

Miva may create these locally:

```text
.env
node_modules/
.wwebjs_auth/
.wwebjs_cache/
shutdown.json
```

These are not part of the GitHub source repository.

- `.env` contains your private configuration.
- `node_modules/` contains installed npm packages.
- `.wwebjs_auth/` stores the WhatsApp login session.
- `.wwebjs_cache/` may contain WhatsApp Web cache data.
- `shutdown.json` stores per-chat shutdown status.


## Troubleshooting

### `GEMINI_API_KEY` not found

Make sure you created a file named exactly `.env` in the same project folder as `bot.js`, and that it contains:

```env
GEMINI_API_KEY=your_real_key
```

### QR code appears after every restart

Make sure the `.wwebjs_auth/` folder is not being deleted and your VPS storage is persistent.

### `@miva` does not reply

Check:

- The bot process is running.
- WhatsApp authentication completed successfully.
- Your message starts with `@miva`.
- The Gemini API key is valid.
- Your server has internet access.
- Your configured Gemini models are available to your API account.

### `@miva_skill` does not work

Check:

- The Hermes service is running.
- `HERMES_API_URL` is correct.
- `HERMES_API_KEY` matches the gateway configuration.
- The Hermes endpoint is reachable from the machine running Miva.

### Puppeteer / Chromium fails on Ubuntu

`whatsapp-web.js` uses a browser through Puppeteer. A headless Ubuntu VPS may require additional Chromium system libraries. Install the missing libraries reported by the terminal, then restart Miva.

## Security Notes

- Never publish API keys.
- Never publish `.wwebjs_auth/`.
- Never share your WhatsApp session files.
- Keep the VPS and Node.js packages updated.
- Use this bot only with accounts and services you are authorized to use.

## Disclaimer

Miva uses `whatsapp-web.js`, which is an unofficial WhatsApp Web automation library and is not affiliated with WhatsApp. Unofficial automation can carry account restrictions or blocking risk. Use it responsibly, especially on important or business WhatsApp accounts.

---

**Miva** — a lightweight personal WhatsApp AI assistant powered by Gemini, with optional Hermes task routing.
