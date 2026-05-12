import OpenAI from "openai";

const ASSISTANT_DISCLAIMER =
  "Это wellness-подсказка, а не медицинская рекомендация. При заболеваниях, беременности, сильном ухудшении самочувствия или подозрении на расстройство пищевого поведения лучше обратиться к врачу.";

const RECIPE_TEMPLATES = [
  {
    title: "Творог с ягодами и орехами",
    calories: 280,
    protein_g: 26,
    fat_g: 11,
    carbs_g: 18,
    ingredients: [
      "творог 5% — 180 г",
      "ягоды — 80 г",
      "грецкие орехи — 10 г",
      "по желанию корица",
    ],
    steps: ["Смешай творог и ягоды.", "Добавь орехи сверху."],
    tags: ["protein", "light", "sweet"],
  },
  {
    title: "Омлет с овощами",
    calories: 320,
    protein_g: 24,
    fat_g: 20,
    carbs_g: 10,
    ingredients: [
      "яйца — 3 шт",
      "помидор — 100 г",
      "шпинат или зелень — 40 г",
      "немного масла для сковороды",
    ],
    steps: ["Взбей яйца.", "Добавь овощи.", "Готовь на среднем огне 5-7 минут."],
    tags: ["protein", "savory"],
  },
  {
    title: "Курица с рисом и овощами",
    calories: 430,
    protein_g: 36,
    fat_g: 10,
    carbs_g: 47,
    ingredients: [
      "куриная грудка — 150 г",
      "рис готовый — 130 г",
      "овощи — 150 г",
      "специи и соль по вкусу",
    ],
    steps: [
      "Обжарь или запеки курицу без лишнего масла.",
      "Подай с рисом и овощами.",
    ],
    tags: ["protein", "balanced"],
  },
  {
    title: "Йогурт с бананом и овсянкой",
    calories: 300,
    protein_g: 17,
    fat_g: 6,
    carbs_g: 45,
    ingredients: [
      "греческий йогурт — 170 г",
      "банан — 1 шт",
      "овсянка — 35 г",
    ],
    steps: ["Смешай йогурт и овсянку.", "Добавь банан сверху."],
    tags: ["carbs", "light", "sweet"],
  },
  {
    title: "Салат с тунцом",
    calories: 290,
    protein_g: 30,
    fat_g: 12,
    carbs_g: 12,
    ingredients: [
      "тунец в собственном соку — 120 г",
      "листовой салат — 80 г",
      "огурец — 100 г",
      "помидоры — 100 г",
      "оливковое масло — 1 ч.л.",
    ],
    steps: ["Нарежь овощи.", "Смешай с тунцом и заправкой."],
    tags: ["protein", "light"],
  },
  {
    title: "Лосось с картофелем",
    calories: 490,
    protein_g: 34,
    fat_g: 23,
    carbs_g: 35,
    ingredients: [
      "лосось — 150 г",
      "картофель — 180 г",
      "овощи или салат — 120 г",
    ],
    steps: ["Запеки картофель.", "Приготовь лосось и подай с овощами."],
    tags: ["balanced", "savory"],
  },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundNumber(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const pow = 10 ** digits;
  return Math.round(n * pow) / pow;
}

function normalizePrompt(text) {
  return (text ?? "").toString().trim().slice(0, 1200);
}

function macroTargetsForCalories(calories) {
  const target = Number(calories);
  if (!Number.isFinite(target) || target <= 0) {
    return { protein_g: 0, fat_g: 0, carbs_g: 0 };
  }
  return {
    protein_g: roundNumber((target * 0.3) / 4, 1),
    fat_g: roundNumber((target * 0.3) / 9, 1),
    carbs_g: roundNumber((target * 0.4) / 4, 1),
  };
}

function summarizeTrend(recentDays) {
  if (!Array.isArray(recentDays) || !recentDays.length) {
    return { averageCalories: null, highDays: 0, lowDays: 0 };
  }
  const totals = recentDays.map((row) => Number(row.calories_total) || 0);
  const averageCalories = Math.round(totals.reduce((sum, value) => sum + value, 0) / totals.length);
  const highDays = totals.filter((value) => value >= averageCalories + 150).length;
  const lowDays = totals.filter((value) => value <= Math.max(0, averageCalories - 150)).length;
  return { averageCalories, highDays, lowDays };
}

function selectTemplates(recipeBudget, hints = []) {
  const normalizedHints = new Set(hints);
  const withScore = RECIPE_TEMPLATES.map((item) => {
    let score = 0;
    if (recipeBudget != null && item.calories <= recipeBudget + 60) score += 3;
    if (recipeBudget != null && item.calories <= recipeBudget) score += 2;
    for (const tag of item.tags) {
      if (normalizedHints.has(tag)) score += 2;
    }
    return { ...item, _score: score };
  });

  return withScore
    .sort((a, b) => b._score - a._score || a.calories - b.calories)
    .slice(0, 3)
    .map(({ _score, ...item }) => item);
}

function buildLocalRecipes(context) {
  const target = Number(context.profile?.daily_calorie_target) || null;
  const remaining = Number(context.daySummary?.remaining_calories);
  const macroTargets = macroTargetsForCalories(target);
  const eatenProtein = Number(context.daySummary?.totals?.protein_g) || 0;
  const proteinGap = Math.max(0, macroTargets.protein_g - eatenProtein);
  const recipeBudget =
    Number.isFinite(remaining) && remaining > 0 ? clamp(Math.round(remaining), 180, 650) : 420;
  const hints = [];
  if (proteinGap >= 20) hints.push("protein");
  if (recipeBudget <= 320) hints.push("light");
  if (recipeBudget >= 430) hints.push("balanced");
  const recipes = selectTemplates(recipeBudget, hints).map((item) => ({
    ...item,
    reason:
      proteinGap >= 20 && item.protein_g >= 24
        ? "Хорошо поможет добрать белок без сильного перебора по калориям."
        : item.calories <= recipeBudget
          ? "Вписывается в остаток калорий на день."
          : "Подойдёт как ориентир на следующий приём пищи или завтра.",
  }));

  return {
    recipeBudget,
    recipes,
  };
}

function buildLocalCoachReply(context, userPrompt) {
  const profile = context.profile || {};
  const daySummary = context.daySummary || {};
  const totals = daySummary.totals || {};
  const target = Number(profile.daily_calorie_target) || null;
  const remaining = Number(daySummary.remaining_calories);
  const macroTargets = macroTargetsForCalories(target);
  const proteinGap = Math.max(0, macroTargets.protein_g - (Number(totals.protein_g) || 0));
  const fatGap = Math.max(0, macroTargets.fat_g - (Number(totals.fat_g) || 0));
  const carbsGap = Math.max(0, macroTargets.carbs_g - (Number(totals.carbs_g) || 0));
  const trend = summarizeTrend(context.recentDays);

  let reply = "";
  if (Number.isFinite(remaining)) {
    if (remaining < 0) {
      reply =
        `Сегодня уже есть перебор примерно на ${Math.abs(remaining)} ккал. ` +
        "Лучше сделать следующий приём пищи легче: белок, овощи, вода и без плотных перекусов вечером.";
    } else if (remaining <= 220) {
      reply =
        `На сегодня осталось около ${remaining} ккал. ` +
        "Лучший вариант сейчас — лёгкий ужин или белковый перекус, чтобы не выйти за лимит.";
    } else {
      reply =
        `На сегодня у тебя осталось около ${remaining} ккал. ` +
        "Можно спокойно собрать ещё один приём пищи, лучше с опорой на белок и умеренные углеводы.";
    }
  } else {
    reply =
      "Сначала лучше опираться на дневной лимит калорий в профиле, чтобы ассистент мог давать более точные рекомендации.";
  }

  if (proteinGap >= 20) {
    reply += ` Белка пока не хватает примерно на ${Math.round(proteinGap)} г — это хороший ориентир для следующего блюда.`;
  } else if (fatGap >= 20 && proteinGap < 12) {
    reply += " По БЖУ сейчас важнее не перебрать жиры и сохранить умеренный объём порции.";
  } else if (carbsGap >= 30 && remaining > 250) {
    reply += " Если нужна энергия на вечер, можно добавить умеренную порцию сложных углеводов.";
  }

  if (trend.averageCalories != null) {
    reply += ` В среднем за последние дни выходит около ${trend.averageCalories} ккал в день.`;
  }

  if (userPrompt) {
    reply += ` По твоему запросу «${userPrompt.slice(0, 120)}» я бы рекомендовал держать фокус на простом и насыщаемом приёме пищи без лишних перекусов.`;
  }

  return {
    title: "Совет на день",
    reply,
    follow_up_prompts: [
      "Что съесть дальше, чтобы не перебрать калории?",
      "Как добрать белок сегодня?",
      "Подбери 3 идеи ужина под мой остаток калорий",
    ],
  };
}

function sanitizeRecipe(recipe) {
  if (!recipe || typeof recipe !== "object") return null;
  const title = (recipe.title ?? "").toString().trim().slice(0, 120);
  if (!title) return null;
  const ingredients = Array.isArray(recipe.ingredients)
    ? recipe.ingredients.map((item) => String(item).trim()).filter(Boolean).slice(0, 10)
    : [];
  const steps = Array.isArray(recipe.steps)
    ? recipe.steps.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    title,
    reason: (recipe.reason ?? "").toString().trim().slice(0, 240),
    calories: Math.max(0, Math.round(Number(recipe.calories) || 0)),
    protein_g: roundNumber(recipe.protein_g),
    fat_g: roundNumber(recipe.fat_g),
    carbs_g: roundNumber(recipe.carbs_g),
    ingredients,
    steps,
  };
}

function sanitizeAssistantPayload(payload, fallbackMode) {
  const followUpPrompts = Array.isArray(payload.follow_up_prompts)
    ? payload.follow_up_prompts
        .map((item) => String(item).trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];
  const recipes = Array.isArray(payload.recipes)
    ? payload.recipes.map(sanitizeRecipe).filter(Boolean).slice(0, 3)
    : [];

  return {
    mode: payload.mode === "recipes" ? "recipes" : fallbackMode,
    title: (payload.title ?? "").toString().trim().slice(0, 120),
    reply: (payload.reply ?? "").toString().trim().slice(0, 1600),
    follow_up_prompts: followUpPrompts,
    recipes,
    disclaimer:
      (payload.disclaimer ?? "").toString().trim().slice(0, 400) || ASSISTANT_DISCLAIMER,
  };
}

function fallbackAssistantPayload(mode, context, userPrompt) {
  if (mode === "recipes") {
    const recipeData = buildLocalRecipes(context);
    return {
      mode,
      title: "Идеи под твой день",
      reply:
        Number.isFinite(recipeData.recipeBudget)
          ? `Я подобрал несколько простых вариантов примерно под ${recipeData.recipeBudget} ккал.`
          : "Я подобрал несколько простых вариантов под твою цель.",
      follow_up_prompts: [
        "Сделай варианты без готовки",
        "Подбери более белковый ужин",
        "Дай ещё рецепты на завтра",
      ],
      recipes: recipeData.recipes,
      disclaimer: ASSISTANT_DISCLAIMER,
    };
  }

  return {
    mode,
    ...buildLocalCoachReply(context, userPrompt),
    recipes: [],
    disclaimer: ASSISTANT_DISCLAIMER,
  };
}

function buildSystemPrompt(mode) {
  const recipePart =
    mode === "recipes"
      ? `Сконцентрируйся на идеях еды и рецептах. Дай до 3 вариантов. У каждого рецепта укажи title, reason, calories, protein_g, fat_g, carbs_g, ingredients, steps.`
      : `Сконцентрируйся на кратком coaching-совете по текущему дню. Не пиши длинно.`;

  return [
    "Ты ассистент по контролю веса и рецептам внутри приложения Calory.",
    "Отвечай по-русски, дружелюбно и конкретно.",
    "Ты не врач. Нельзя ставить диагнозы, назначать лечение, советовать экстремальные диеты или опасно низкие калории.",
    "Если контекст похож на медицинский риск, беременность, серьёзное заболевание или расстройство пищевого поведения, мягко советуй обратиться к врачу или профильному специалисту.",
    "Не выдумывай данные, которых нет в контексте. Если оценка приблизительная, так и скажи.",
    recipePart,
    'Ответь только JSON без markdown по схеме: {"mode":"coach|recipes","title":"...","reply":"...","follow_up_prompts":["..."],"recipes":[{"title":"...","reason":"...","calories":123,"protein_g":10,"fat_g":4,"carbs_g":15,"ingredients":["..."],"steps":["..."]}],"disclaimer":"..."}',
  ].join(" ");
}

function buildUserPayload(context, mode, userPrompt) {
  return {
    mode,
    user_prompt: userPrompt || null,
    profile: {
      name: context.profile?.name ?? null,
      age: context.profile?.age ?? null,
      gender: context.profile?.gender ?? null,
      goal: context.profile?.goal ?? null,
      weight_kg: context.profile?.weight_kg ?? null,
      target_weight_kg: context.profile?.target_weight_kg ?? null,
      target_weeks: context.profile?.target_weeks ?? null,
      daily_calorie_target: context.profile?.daily_calorie_target ?? null,
    },
    selected_day: {
      log_date: context.daySummary?.log_date ?? null,
      calories: Math.round(Number(context.daySummary?.totals?.calories) || 0),
      protein_g: roundNumber(context.daySummary?.totals?.protein_g),
      fat_g: roundNumber(context.daySummary?.totals?.fat_g),
      carbs_g: roundNumber(context.daySummary?.totals?.carbs_g),
      remaining_calories: context.daySummary?.remaining_calories ?? null,
      meals: Array.isArray(context.daySummary?.meals)
        ? context.daySummary.meals.slice(-8).map((meal) => ({
            raw_text: meal.raw_text,
            calories: Math.round(Number(meal.calories) || 0),
            protein_g: roundNumber(meal.protein_g),
            fat_g: roundNumber(meal.fat_g),
            carbs_g: roundNumber(meal.carbs_g),
          }))
        : [],
    },
    recent_days: Array.isArray(context.recentDays)
      ? context.recentDays.slice(0, 7).map((row) => ({
          log_date: row.log_date,
          calories_total: Math.round(Number(row.calories_total) || 0),
        }))
      : [],
    saved_dishes: Array.isArray(context.savedDishes)
      ? context.savedDishes.slice(0, 12).map((dish) => ({
          title: dish.title,
          calories: Math.round(Number(dish.calories) || 0),
          protein_g: roundNumber(dish.protein_g),
          fat_g: roundNumber(dish.fat_g),
          carbs_g: roundNumber(dish.carbs_g),
          portion_grams: dish.portion_grams == null ? null : roundNumber(dish.portion_grams),
        }))
      : [],
  };
}

export async function generateAssistantReply({ mode = "coach", prompt = "", context }) {
  const safeMode = mode === "recipes" ? "recipes" : "coach";
  const userPrompt = normalizePrompt(prompt);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return fallbackAssistantPayload(safeMode, context, userPrompt);
  }

  const client = new OpenAI({ apiKey });
  const model =
    process.env.OPENAI_ASSISTANT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";

  try {
    const res = await client.chat.completions.create({
      model,
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(safeMode) },
        { role: "user", content: JSON.stringify(buildUserPayload(context, safeMode, userPrompt)) },
      ],
    });
    const raw = res.choices[0]?.message?.content;
    if (!raw) {
      return fallbackAssistantPayload(safeMode, context, userPrompt);
    }
    const parsed = JSON.parse(raw);
    const sanitized = sanitizeAssistantPayload(parsed, safeMode);
    if (!sanitized.reply) {
      return fallbackAssistantPayload(safeMode, context, userPrompt);
    }
    if (safeMode === "recipes" && !sanitized.recipes.length) {
      return fallbackAssistantPayload(safeMode, context, userPrompt);
    }
    return sanitized;
  } catch {
    return fallbackAssistantPayload(safeMode, context, userPrompt);
  }
}

export { ASSISTANT_DISCLAIMER };
