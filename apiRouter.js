import { Router } from "express";
import multer from "multer";
import { verifyTelegramWebAppInitData } from "./lib/verifyTelegramWebApp.js";
import { computeCaloriePlan } from "./lib/nutrition.js";
import { getSupabase } from "./lib/db.js";
import { refineCaloriePlanWithAI } from "./lib/profileOpenai.js";
import {
  estimateMealWithOpenAI,
  estimateMealFromImage,
} from "./lib/mealOpenai.js";
import {
  ASSISTANT_DISCLAIMER,
  generateAssistantReply,
} from "./lib/assistantOpenai.js";
import { normalizeMacros } from "./lib/macros.js";
import {
  calendarDateInTimeZone,
  subtractCalendarDays,
  resolveCalendarTimeZone,
} from "./lib/dateTz.js";

const router = Router();

const uuidRe =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestTimeZone(req) {
  const headerValue = req.headers["x-user-timezone"];
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return resolveCalendarTimeZone(raw);
}

/** Понятное сообщение, если таблица ещё не создана в Supabase. */
function savedDishesErrorResponse(error) {
  const raw = (error && error.message) || "";
  if (/saved_dishes|schema cache|Could not find the table/i.test(raw)) {
    return {
      status: 503,
      error:
        "Таблица saved_dishes не найдена. В Supabase: SQL Editor → выполни скрипт из файла sql/saved_dishes.sql (или sql/schema.sql), затем обнови Mini App.",
    };
  }
  return { status: 500, error: raw || "Ошибка базы данных" };
}

function profileSchemaErrorResponse(error) {
  const raw = (error && error.message) || "";
  if (/name|target_weight_kg|target_weeks|schema cache|Could not find the column/i.test(raw)) {
    return {
      status: 503,
      error:
        "Профиль ещё не обновлён в базе. В Supabase открой SQL Editor и выполни скрипт из файла sql/profile_goal_upgrade.sql, затем обнови Mini App.",
    };
  }
  return { status: 500, error: raw || "Ошибка базы данных" };
}

function profileSchemaReady(row) {
  if (!row) return true;
  return (
    Object.prototype.hasOwnProperty.call(row, "name") &&
    Object.prototype.hasOwnProperty.call(row, "target_weight_kg") &&
    Object.prototype.hasOwnProperty.call(row, "target_weeks")
  );
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error("Допустимы только JPEG, PNG, WebP, GIF."));
  },
});

router.get("/health", (_req, res) => {
  const url = process.env.SUPABASE_URL?.trim();
  const sbKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim();
  res.json({
    ok: true,
    message: "Сервер работает. Профиль и еда — через /api/profile и /api/meals.",
    checks: {
      supabase: Boolean(url && sbKey),
      openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
      telegram_bot: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
      web_app_url: Boolean(process.env.WEB_APP_URL?.trim()),
    },
  });
});

function telegramAuth(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];
  if (!initData || typeof initData !== "string") {
    return res.status(401).json({
      error: "Открой приложение из Telegram (нет initData).",
    });
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return res.status(500).json({ error: "На сервере не задан TELEGRAM_BOT_TOKEN." });
  }
  const v = verifyTelegramWebAppInitData(initData, botToken);
  if (!v.ok) {
    return res.status(401).json({ error: "Неверная подпись Telegram. Закрой и открой Mini App снова." });
  }
  req.tgUserId = v.user.id;
  req.tgUser = v.user;
  req.userTimeZone = requestTimeZone(req);
  next();
}

router.get("/profile", telegramAuth, async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("telegram_user_id", req.tgUserId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!profileSchemaReady(data)) {
    const e = profileSchemaErrorResponse({ message: "target_weight_kg target_weeks name" });
    return res.status(e.status).json({ error: e.error });
  }
  let caloriePlan = null;
  if (data) {
    try {
      const computedPlan = computeCaloriePlan(data);
      caloriePlan = {
        ...computedPlan,
        daily_calorie_target: Number(data.daily_calorie_target) || null,
        note: computedPlan.note || "Сохранённый лимит калорий из профиля.",
      };
    } catch {
      caloriePlan = null;
    }
  }
  res.json({ profile: data, calorie_plan: caloriePlan });
});

router.post("/profile", telegramAuth, async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }

  const { name, age, height_cm, weight_kg, gender, goal, target_weight_kg, target_weeks } =
    req.body || {};
  const allowedG = new Set(["male", "female"]);
  const allowedGoal = new Set(["lose", "maintain", "gain"]);

  if (!allowedG.has(gender) || !allowedGoal.has(goal)) {
    return res.status(400).json({ error: "Проверь пол (male/female) и цель (lose/maintain/gain)." });
  }

  const displayName = (name ?? req.tgUser?.first_name ?? req.tgUser?.username ?? "")
    .toString()
    .trim();
  if (displayName && displayName.length > 100) {
    return res.status(400).json({ error: "Имя должно быть не длиннее 100 символов." });
  }

  const a = Number(age);
  const h = Number(height_cm);
  const w = Number(weight_kg);
  if (![a, h, w].every((n) => Number.isFinite(n))) {
    return res.status(400).json({ error: "Возраст, рост и вес должны быть числами." });
  }

  const targetWeight =
    target_weight_kg === "" || target_weight_kg == null ? null : Number(target_weight_kg);
  const targetWeeks =
    target_weeks === "" || target_weeks == null ? null : Number(target_weeks);
  if (targetWeight != null && (!Number.isFinite(targetWeight) || targetWeight <= 0)) {
    return res.status(400).json({ error: "Желаемый вес должен быть положительным числом." });
  }
  if (targetWeeks != null && (!Number.isFinite(targetWeeks) || targetWeeks <= 0)) {
    return res.status(400).json({ error: "Срок должен быть положительным числом недель." });
  }
  if ((targetWeight == null) !== (targetWeeks == null)) {
    return res.status(400).json({ error: "Для калькулятора цели укажи и желаемый вес, и срок." });
  }

  let caloriePlan;
  try {
    caloriePlan = computeCaloriePlan({
      age: a,
      height_cm: h,
      weight_kg: w,
      gender,
      goal,
      target_weight_kg: targetWeight,
      target_weeks: targetWeeks,
    });
  } catch {
    return res.status(400).json({ error: "Не удалось посчитать норму калорий." });
  }

  try {
    caloriePlan = await refineCaloriePlanWithAI(
      {
        name: displayName || null,
        age: a,
        height_cm: h,
        weight_kg: w,
        target_weight_kg: targetWeight,
        target_weeks: targetWeeks,
        gender,
        goal,
      },
      caloriePlan
    );
  } catch {
    // AI-подсказка необязательна: при ошибке сохраняем безопасный формульный расчёт.
  }

  const row = {
    telegram_user_id: req.tgUserId,
    name: displayName || null,
    age: Math.round(a),
    height_cm: Math.round(h),
    weight_kg: w,
    target_weight_kg: targetWeight,
    target_weeks: targetWeeks == null ? null : Math.round(targetWeeks),
    gender,
    goal,
    daily_calorie_target: caloriePlan.daily_calorie_target,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("profiles")
    .upsert(row, { onConflict: "telegram_user_id" })
    .select()
    .single();

  if (error) {
    const e = profileSchemaErrorResponse(error);
    return res.status(e.status).json({ error: e.error });
  }
  if (!profileSchemaReady(data)) {
    const e = profileSchemaErrorResponse({ message: "target_weight_kg target_weeks name" });
    return res.status(e.status).json({ error: e.error });
  }
  res.json({ profile: data, calorie_plan: caloriePlan });
});

router.get("/saved-dishes", telegramAuth, async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }
  const { data, error } = await supabase
    .from("saved_dishes")
    .select("*")
    .eq("telegram_user_id", req.tgUserId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    const e = savedDishesErrorResponse(error);
    return res.status(e.status).json({ error: e.error });
  }
  res.json({ dishes: data ?? [] });
});

router.post("/saved-dishes", telegramAuth, async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("telegram_user_id")
    .eq("telegram_user_id", req.tgUserId)
    .maybeSingle();
  if (!profile) {
    return res.status(400).json({ error: "Сначала сохрани профиль в настройках." });
  }

  const title = (req.body?.title ?? "").toString().trim();
  const portion_grams =
    req.body?.portion_grams === "" || req.body?.portion_grams == null
      ? null
      : Number(req.body.portion_grams);

  if (title.length < 2 || title.length > 200) {
    return res.status(400).json({ error: "Название блюда: от 2 до 200 символов." });
  }
  if (portion_grams != null && (!Number.isFinite(portion_grams) || portion_grams <= 0)) {
    return res.status(400).json({ error: "Вес порции должен быть положительным числом." });
  }

  let est;
  try {
    est = normalizeMacros(req.body);
  } catch {
    return res.status(400).json({ error: "Проверь поля калорий и БЖУ." });
  }

  const { data, error } = await supabase
    .from("saved_dishes")
    .insert({
      telegram_user_id: req.tgUserId,
      title,
      portion_grams,
      calories: est.calories,
      protein_g: est.protein_g,
      fat_g: est.fat_g,
      carbs_g: est.carbs_g,
    })
    .select()
    .single();

  if (error) {
    const e = savedDishesErrorResponse(error);
    return res.status(e.status).json({ error: e.error });
  }
  res.json({ dish: data });
});

router.patch("/saved-dishes/:id", telegramAuth, async (req, res) => {
  const id = req.params.id;
  if (!id || !uuidRe.test(id)) {
    return res.status(400).json({ error: "Некорректный id." });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }

  const title = (req.body?.title ?? "").toString().trim();
  const portion_grams =
    req.body?.portion_grams === "" || req.body?.portion_grams == null
      ? null
      : Number(req.body.portion_grams);

  if (title.length < 2 || title.length > 200) {
    return res.status(400).json({ error: "Название блюда: от 2 до 200 символов." });
  }
  if (portion_grams != null && (!Number.isFinite(portion_grams) || portion_grams <= 0)) {
    return res.status(400).json({ error: "Вес порции должен быть положительным числом." });
  }

  let est;
  try {
    est = normalizeMacros(req.body);
  } catch {
    return res.status(400).json({ error: "Проверь поля калорий и БЖУ." });
  }

  const { data: dish, error } = await supabase
    .from("saved_dishes")
    .update({
      title,
      portion_grams,
      calories: est.calories,
      protein_g: est.protein_g,
      fat_g: est.fat_g,
      carbs_g: est.carbs_g,
    })
    .eq("id", id)
    .eq("telegram_user_id", req.tgUserId)
    .select("*")
    .maybeSingle();

  if (error) {
    const e = savedDishesErrorResponse(error);
    return res.status(e.status).json({ error: e.error });
  }
  if (!dish) return res.status(404).json({ error: "Не найдено." });
  res.json({ dish });
});

router.delete("/saved-dishes/:id", telegramAuth, async (req, res) => {
  const id = req.params.id;
  if (!id || !uuidRe.test(id)) {
    return res.status(400).json({ error: "Некорректный id." });
  }
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }
  const { data, error } = await supabase
    .from("saved_dishes")
    .delete()
    .eq("id", id)
    .eq("telegram_user_id", req.tgUserId)
    .select("id");

  if (error) {
    const e = savedDishesErrorResponse(error);
    return res.status(e.status).json({ error: e.error });
  }
  if (!data?.length) return res.status(404).json({ error: "Не найдено." });
  res.json({ ok: true });
});

router.post(
  "/meals/estimate-image",
  telegramAuth,
  (req, res, next) => {
    upload.single("photo")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || "Ошибка загрузки файла." });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Прикрепи фото в поле photo." });
    }
    try {
      const estimate = await estimateMealFromImage(
        req.file.buffer,
        req.file.mimetype
      );
      res.json({ estimate });
    } catch (e) {
      const msg = e?.message || "OpenAI error";
      res.status(502).json({ error: msg });
    }
  }
);

router.post("/meals", telegramAuth, async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }

  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("telegram_user_id")
    .eq("telegram_user_id", req.tgUserId)
    .maybeSingle();

  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!profile) {
    return res.status(400).json({ error: "Сначала сохрани профиль в настройках." });
  }

  const text = (req.body?.text ?? "").toString().trim();
  const manual = ["calories", "protein_g", "fat_g", "carbs_g"].every(
    (k) => req.body?.[k] !== undefined && req.body?.[k] !== null && String(req.body[k]).trim() !== ""
  );

  let raw_text = text;
  let est;
  if (manual) {
    try {
      est = normalizeMacros(req.body);
    } catch {
      return res.status(400).json({ error: "Проверь числа калорий и БЖУ." });
    }
    if (raw_text.length < 2) raw_text = "Блюдо (оценка вручную)";
  } else {
    if (text.length < 2) {
      return res.status(400).json({
        error: "Опиши еду текстом или передай готовые калории и БЖУ.",
      });
    }
    try {
      est = await estimateMealWithOpenAI(text);
    } catch (e) {
      const msg = e?.message || "OpenAI error";
      return res.status(502).json({ error: msg });
    }
  }

  const out = await insertMealWithSummary(supabase, req.tgUserId, req.userTimeZone, {
    raw_text,
    est,
  });
  if (out.error) {
    return res.status(500).json({ error: out.error, meal: out.meal });
  }
  res.json({ meal: out.meal, summary: out.summary });
});

router.post("/meals/from-saved", telegramAuth, async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }

  const sid = (req.body?.saved_dish_id ?? "").toString().trim();
  if (!sid || !uuidRe.test(sid)) {
    return res.status(400).json({ error: "Нужен saved_dish_id (uuid)." });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("telegram_user_id")
    .eq("telegram_user_id", req.tgUserId)
    .maybeSingle();
  if (!profile) {
    return res.status(400).json({ error: "Сначала сохрани профиль в настройках." });
  }

  const { data: dish, error: dErr } = await supabase
    .from("saved_dishes")
    .select("*")
    .eq("id", sid)
    .eq("telegram_user_id", req.tgUserId)
    .maybeSingle();

  if (dErr) return res.status(500).json({ error: dErr.message });
  if (!dish) return res.status(404).json({ error: "Сохранённое блюдо не найдено." });

  const actualRaw = req.body?.actual_grams;
  const actual_grams =
    actualRaw === "" || actualRaw == null ? null : Number(actualRaw);

  let scale = 1;
  if (
    dish.portion_grams != null &&
    Number(dish.portion_grams) > 0 &&
    actual_grams != null &&
    Number.isFinite(actual_grams) &&
    actual_grams > 0
  ) {
    scale = actual_grams / Number(dish.portion_grams);
  }

  const est = normalizeMacros({
    calories: Number(dish.calories) * scale,
    protein_g: Number(dish.protein_g) * scale,
    fat_g: Number(dish.fat_g) * scale,
    carbs_g: Number(dish.carbs_g) * scale,
  });

  let raw_text = dish.title;
  if (actual_grams != null && Number.isFinite(actual_grams) && actual_grams > 0) {
    raw_text += ` (${Math.round(actual_grams)} г)`;
  } else if (dish.portion_grams != null && Number(dish.portion_grams) > 0) {
    raw_text += ` (${Number(dish.portion_grams)} г)`;
  }

  const out = await insertMealWithSummary(supabase, req.tgUserId, req.userTimeZone, {
    raw_text,
    est,
  });
  if (out.error) {
    return res.status(500).json({ error: out.error, meal: out.meal });
  }
  res.json({ meal: out.meal, summary: out.summary });
});

router.get("/meals/today", telegramAuth, async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }
  const log_date = calendarDateInTimeZone(new Date(), req.userTimeZone);
  const summary = await loadDaySummary(supabase, req.tgUserId, log_date);
  if (summary.error) {
    return res.status(500).json({ error: summary.error });
  }
  res.json(summary);
});

const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;

router.get("/meals/day", telegramAuth, async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }
  const q = (req.query.date ?? "").toString().trim();
  const today = calendarDateInTimeZone(new Date(), req.userTimeZone);
  if (!q || !isoDateRe.test(q)) {
    return res.status(400).json({ error: "Укажи date в формате YYYY-MM-DD." });
  }
  if (q > today) {
    return res.status(400).json({ error: "Нельзя смотреть будущие даты." });
  }
  if (q < subtractCalendarDays(today, 400)) {
    return res.status(400).json({ error: "Слишком старая дата." });
  }
  const summary = await loadDaySummary(supabase, req.tgUserId, q);
  if (summary.error) {
    return res.status(500).json({ error: summary.error });
  }
  res.json(summary);
});

router.get("/meals/recent-days", telegramAuth, async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }
  const limit = Math.min(31, Math.max(1, Number(req.query.limit) || 14));
  const today = calendarDateInTimeZone(new Date(), req.userTimeZone);
  const since = subtractCalendarDays(today, limit - 1);

  const { data: rows, error } = await supabase
    .from("meals")
    .select("log_date, calories")
    .eq("telegram_user_id", req.tgUserId)
    .gte("log_date", since)
    .lte("log_date", today);

  if (error) return res.status(500).json({ error: error.message });

  const totals = new Map();
  for (const row of rows ?? []) {
    const d = row.log_date;
    totals.set(d, (totals.get(d) || 0) + (Number(row.calories) || 0));
  }

  const days = [];
  for (let i = 0; i < limit; i++) {
    const log_date = subtractCalendarDays(today, i);
    days.push({
      log_date,
      calories_total: Math.round(totals.get(log_date) || 0),
    });
  }

  res.json({ today, days });
});

router.post("/assistant/chat", telegramAuth, async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }

  const mode = req.body?.mode === "recipes" ? "recipes" : "coach";
  const prompt = (req.body?.prompt ?? "").toString().trim();
  const selectedDateRaw = (req.body?.date ?? "").toString().trim();
  const selectedDate =
    selectedDateRaw && isoDateRe.test(selectedDateRaw)
      ? selectedDateRaw
      : calendarDateInTimeZone(new Date(), req.userTimeZone);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("telegram_user_id", req.tgUserId)
    .maybeSingle();

  if (profileError) {
    const e = profileSchemaErrorResponse(profileError);
    return res.status(e.status).json({ error: e.error });
  }
  if (!profile) {
    return res.status(400).json({ error: "Сначала сохрани профиль в настройках." });
  }
  if (!profileSchemaReady(profile)) {
    const e = profileSchemaErrorResponse({ message: "target_weight_kg target_weeks name" });
    return res.status(e.status).json({ error: e.error });
  }

  const daySummary = await loadDaySummary(supabase, req.tgUserId, selectedDate);
  if (daySummary.error) {
    return res.status(500).json({ error: daySummary.error });
  }

  const [recentDays, savedDishes] = await Promise.all([
    loadRecentDayTotals(supabase, req.tgUserId, req.userTimeZone, 7),
    loadSavedDishesBrief(supabase, req.tgUserId),
  ]);

  const assistant = await generateAssistantReply({
    mode,
    prompt,
    context: {
      profile: {
        ...profile,
        name: profile.name || req.tgUser?.first_name || req.tgUser?.username || null,
      },
      daySummary,
      recentDays,
      savedDishes,
    },
  });

  res.json({
    assistant: {
      ...assistant,
      disclaimer: assistant.disclaimer || ASSISTANT_DISCLAIMER,
    },
    context: {
      date: selectedDate,
      current_today: calendarDateInTimeZone(new Date(), req.userTimeZone),
      remaining_calories: daySummary.remaining_calories,
    },
  });
});

router.patch("/meals/:id", telegramAuth, async (req, res) => {
  const id = req.params.id;
  if (!id || !uuidRe.test(id)) {
    return res.status(400).json({ error: "Некорректный id записи." });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }

  const raw_text = (req.body?.text ?? "").toString().trim();
  if (raw_text.length < 2) {
    return res.status(400).json({ error: "Название записи: от 2 символов." });
  }

  let est;
  try {
    est = normalizeMacros(req.body);
  } catch {
    return res.status(400).json({ error: "Проверь числа калорий и БЖУ." });
  }

  const { data: meal, error } = await supabase
    .from("meals")
    .update({
      raw_text,
      calories: est.calories,
      protein_g: est.protein_g,
      fat_g: est.fat_g,
      carbs_g: est.carbs_g,
    })
    .eq("id", id)
    .eq("telegram_user_id", req.tgUserId)
    .select("*")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!meal) {
    return res.status(404).json({ error: "Запись не найдена или чужая." });
  }

  const summary = await loadDaySummary(supabase, req.tgUserId, meal.log_date);
  if (summary.error) {
    return res.status(500).json({ error: summary.error, meal });
  }
  res.json({ meal, summary });
});

router.delete("/meals/:id", telegramAuth, async (req, res) => {
  const id = req.params.id;
  if (!id || !uuidRe.test(id)) {
    return res.status(400).json({ error: "Некорректный id записи." });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase не настроен (SUPABASE_URL и ключ)." });
  }

  const { data, error } = await supabase
    .from("meals")
    .delete()
    .eq("id", id)
    .eq("telegram_user_id", req.tgUserId)
    .select("id, log_date");

  if (error) return res.status(500).json({ error: error.message });
  if (!data?.length) {
    return res.status(404).json({ error: "Запись не найдена или чужая." });
  }

  const logDate = data[0].log_date;
  const summary = await loadDaySummary(supabase, req.tgUserId, logDate);
  if (summary.error) {
    return res.status(500).json({ error: summary.error });
  }
  res.json({ ok: true, summary });
});

async function insertMealWithSummary(supabase, telegramUserId, timeZone, { raw_text, est }) {
  const log_date = calendarDateInTimeZone(new Date(), timeZone);
  const { data: meal, error: mErr } = await supabase
    .from("meals")
    .insert({
      telegram_user_id: telegramUserId,
      raw_text,
      calories: est.calories,
      protein_g: est.protein_g,
      fat_g: est.fat_g,
      carbs_g: est.carbs_g,
      log_date,
    })
    .select()
    .single();

  if (mErr) return { error: mErr.message };
  const summary = await loadDaySummary(supabase, telegramUserId, log_date);
  if (summary.error) return { error: summary.error, meal };
  return { meal, summary };
}

async function loadRecentDayTotals(supabase, telegramUserId, timeZone, limit = 7) {
  const today = calendarDateInTimeZone(new Date(), timeZone);
  const since = subtractCalendarDays(today, Math.max(1, limit) - 1);
  const { data, error } = await supabase
    .from("meals")
    .select("log_date, calories")
    .eq("telegram_user_id", telegramUserId)
    .gte("log_date", since)
    .lte("log_date", today);

  if (error) return [];

  const totals = new Map();
  for (const row of data ?? []) {
    totals.set(row.log_date, (totals.get(row.log_date) || 0) + (Number(row.calories) || 0));
  }

  const out = [];
  for (let i = 0; i < Math.max(1, limit); i++) {
    const log_date = subtractCalendarDays(today, i);
    out.push({
      log_date,
      calories_total: Math.round(totals.get(log_date) || 0),
    });
  }
  return out;
}

async function loadSavedDishesBrief(supabase, telegramUserId) {
  const { data, error } = await supabase
    .from("saved_dishes")
    .select("title, portion_grams, calories, protein_g, fat_g, carbs_g")
    .eq("telegram_user_id", telegramUserId)
    .order("created_at", { ascending: false })
    .limit(12);

  if (error) return [];
  return data ?? [];
}

async function loadDaySummary(supabase, telegramUserId, log_date) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  const { data: meals, error } = await supabase
    .from("meals")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .eq("log_date", log_date)
    .order("eaten_at", { ascending: true });

  if (error) {
    return {
      log_date,
      profile,
      meals: [],
      totals: { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
      remaining_calories: null,
      error: error.message,
    };
  }

  const eaten = (meals ?? []).reduce(
    (acc, m) => {
      acc.calories += Number(m.calories) || 0;
      acc.protein_g += Number(m.protein_g) || 0;
      acc.fat_g += Number(m.fat_g) || 0;
      acc.carbs_g += Number(m.carbs_g) || 0;
      return acc;
    },
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 }
  );

  const target = profile?.daily_calorie_target ?? null;
  const remaining =
    target == null ? null : Math.round(target - eaten.calories);

  return {
    log_date,
    profile,
    meals: meals ?? [],
    totals: eaten,
    remaining_calories: remaining,
  };
}

export { router as apiRouter };
