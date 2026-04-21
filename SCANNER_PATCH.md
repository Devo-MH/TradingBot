# Scanner Integration — Status: DONE

scanner_v6.js has been patched. No further changes needed.

---

## What was added to scanner_v6.js

**Line 23** — require at the top:

```js
const { forwardSignal } = require('./src/scannerPatch');
```

**After regular signal send** (main scan loop):

```js
await sendTelegram(formatMessage(r, false));
forwardSignal(r);   // added
```

**After pre-pump send:**

```js
await sendTelegram(formatPrePumpAlert(pp));
forwardSignal(pp);  // added
```

---

## How to run

**Fill in your tokens first — open `.env` and replace the placeholders:**

```env
TELEGRAM_TOKEN=your_bot_token_from_BotFather
BINANCE_API_KEY=your_binance_read_only_key
BINANCE_SECRET=your_binance_secret
CRYPTOPANIC_TOKEN=optional_for_news
```

**Then start:**

```bash
cd "/Users/dina/Trading Bot"
npm start
```

This runs `launcher.js` which starts both the bot and scanner together.

---

## Test before going live

Type `/testsignal` in Telegram after starting. You will see a complete
signal card with your position sizes to verify everything looks correct.
