import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { startTelegramBot, stopTelegramBot } from "./bot.js";
import { apiRouter } from "./apiRouter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Всегда читаем .env из папки проекта (рядом с server.js), а не из текущей cwd.
dotenv.config({ path: path.join(__dirname, ".env") });

const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
  process.env.SUPABASE_ANON_KEY?.trim();
if (!process.env.SUPABASE_URL?.trim() || !supabaseKey) {
  console.warn(
    "[env] Нет SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY — API БД вернёт 503."
  );
} else {
  console.log("[env] Supabase переменные найдены.");
}
if (!process.env.OPENAI_API_KEY?.trim()) {
  console.warn(
    "[env] Нет OPENAI_API_KEY — кнопка «Добавить и оценить (AI)» будет выдавать ошибку."
  );
}
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use("/api", apiRouter);
app.use(express.static(path.join(__dirname, "public")));

const server = app.listen(PORT, () => {
  console.log(`Сервер: http://localhost:${PORT}`);
  console.log(`Проверка API: http://localhost:${PORT}/api/health`);
  startTelegramBot();
});

async function shutdown(signal) {
  console.log(signal ? `\n[сервер] ${signal}, останавливаюсь…` : "\n[сервер] Останавливаюсь…");
  await stopTelegramBot();
  server.close(() => {
    console.log("[сервер] Порт закрыт. Пока.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
