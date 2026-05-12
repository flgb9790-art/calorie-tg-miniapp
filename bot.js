import fs from "fs";
import path from "path";
import TelegramBot from "node-telegram-bot-api";
import { fileURLToPath } from "url";

let activeBot = null;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function welcomeText() {
  return [
    "<b>Calory</b> — мини-приложение для удобного подсчёта калорий.",
    "",
    "Что внутри:",
    "• быстрый дневник еды и приёмов пищи",
    "• подсчёт калорий и БЖУ",
    "• сохранённые блюда и порции",
    "• история по дням и личная цель",
    "",
    "Нажми кнопку ниже, чтобы открыть приложение.",
  ].join("\n");
}

async function sendWelcome(bot, chatId, webAppUrl) {
  const text = welcomeText();
  const options = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Открыть Calory", web_app: { url: webAppUrl } }],
      ],
    },
  };
  const logoPhotoPath = path.join(
    process.env.LOCALAPPDATA || "",
    "Temp",
    "cursor",
    "screenshots",
    "logo-calory-mark-v3-bot-card-light.png"
  );
  const logoDocumentPath = path.join(__dirname, "public", "logo-calory-mark-v3.svg");

  if (fs.existsSync(logoPhotoPath)) {
    try {
      await bot.sendPhoto(chatId, logoPhotoPath, {
        ...options,
        caption: text,
      });
      return;
    } catch (e) {
      console.warn("[бот] Не удалось отправить логотип в приветствии:", e?.message || e);
    }
  }

  if (fs.existsSync(logoDocumentPath)) {
    try {
      await bot.sendDocument(chatId, logoDocumentPath, {
        ...options,
        caption: text,
      });
      return;
    } catch (e) {
      console.warn("[бот] Не удалось отправить SVG-логотип в приветствии:", e?.message || e);
    }
  }

  await bot.sendMessage(chatId, text, options);
}

/**
 * Запускает бота в режиме polling (Telegram сам шлёт обновления на твой ПК).
 * Mini App открывается только по HTTPS — для локалки используй ngrok и WEB_APP_URL.
 */
export function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.warn(
      "[бот] TELEGRAM_BOT_TOKEN не задан — бот не запущен. Добавь токен в .env"
    );
    return null;
  }

  const webAppUrl = process.env.WEB_APP_URL?.trim();

  const bot = new TelegramBot(token, { polling: true });
  activeBot = bot;

  bot.setMyCommands([
    { command: "start", description: "Открыть приложение" },
    { command: "help", description: "Помощь" },
  ]).catch(() => {});

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!webAppUrl) {
      bot.sendMessage(
        chatId,
        [
          "Токен бота есть, но не настроен адрес Mini App.",
          "",
          "1) Запусти туннель к порту сервера, например: ngrok http 3000",
          "2) В .env укажи WEB_APP_URL=https://твой-поддомен.ngrok-free.app",
          "3) Перезапусти сервер (npm start)",
        ].join("\n")
      );
      return;
    }

    sendWelcome(bot, chatId, webAppUrl).catch((e) => {
      console.error("[бот] Ошибка приветствия:", e?.message || e);
      bot.sendMessage(chatId, "Нажми кнопку, чтобы открыть приложение:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Открыть Calory", web_app: { url: webAppUrl } }],
          ],
        },
      }).catch(() => {});
    });
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      [
        "Этот бот открывает Mini App для подсчёта калорий.",
        "Команды: /start — кнопка приложения, /help — эта подсказка.",
      ].join("\n")
    );
  });

  bot.on("polling_error", (err) => {
    console.error("[бот] polling_error:", err.message);
  });

  console.log("[бот] Запущен (long polling). Напиши боту /start в Telegram.");
  return bot;
}

/** Корректная остановка polling (Ctrl+C / остановка контейнера). */
export async function stopTelegramBot() {
  const bot = activeBot;
  activeBot = null;
  if (!bot) return;
  try {
    await bot.stopPolling();
    console.log("[бот] Polling остановлен.");
  } catch (e) {
    console.error("[бот] Ошибка при остановке:", e?.message || e);
  }
}
