import OpenAI from "openai";
import { normalizeMacros } from "./macros.js";

const system = `Ты помощник по питанию. Пользователь пишет приём пищи свободным текстом на русском.
Оцени суммарно КБЖУ за всё блюдо целиком (примерно).
Ответь только JSON без markdown:
{"calories":число,"protein_g":число,"fat_g":число,"carbs_g":число}
Числа — обычные float, калории целое или float.`;

const visionSystem = `Ты помощник по питанию. По фотографии еды оцени примерную порцию (то, что видно на снимке).
Ответь только JSON без markdown:
{"calories":число,"protein_g":число,"fat_g":число,"carbs_g":число,"description_ru":"кратко по-русски что на фото"}`;

export async function estimateMealWithOpenAI(text) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY не задан");

  const client = new OpenAI({ apiKey });
  const userText = text.trim().slice(0, 2000);

  const res = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
  });

  const raw = res.choices[0]?.message?.content;
  if (!raw) throw new Error("Пустой ответ модели");

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Модель вернула не JSON");
  }

  return normalizeMacros(data);
}

/**
 * Оценка КБЖУ по фото (Vision).
 * @param {Buffer} buffer
 * @param {string} mimeType image/jpeg, image/png, …
 */
export async function estimateMealFromImage(buffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY не задан");

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
  const b64 = buffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${b64}`;

  const res = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: visionSystem },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: dataUrl, detail: "low" },
          },
          {
            type: "text",
            text: "Оцени КБЖУ для всего видимого блюда.",
          },
        ],
      },
    ],
  });

  const raw = res.choices[0]?.message?.content;
  if (!raw) throw new Error("Пустой ответ модели");

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Модель вернула не JSON");
  }

  const macros = normalizeMacros(data);
  const description_ru = (data.description_ru ?? "").toString().trim().slice(0, 500);
  return { ...macros, description_ru };
}
