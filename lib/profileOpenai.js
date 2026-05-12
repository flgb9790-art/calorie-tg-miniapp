import OpenAI from "openai";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export async function refineCaloriePlanWithAI(profile, basePlan) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return basePlan;

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_PROFILE_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const safeMax = Math.round(basePlan.tdee + 1000);

  const system = `Ты помощник по питанию.
Пользователь заполняет профиль приложения для контроля веса.
Нужно предложить реалистичный дневной лимит калорий на основе данных пользователя.
Строго соблюдай ограничения безопасности:
- не ниже min_calories
- не выше safe_max_calories
- не советуй экстремальные дефициты
Ответь только JSON без markdown:
{"daily_calorie_target":число,"note":"короткое пояснение по-русски"}`;

  const userPayload = {
    profile: {
      name: profile.name ?? null,
      age: profile.age,
      height_cm: profile.height_cm,
      weight_kg: profile.weight_kg,
      target_weight_kg: profile.target_weight_kg ?? null,
      target_weeks: profile.target_weeks ?? null,
      gender: profile.gender,
      goal: profile.goal,
    },
    baseline: {
      tdee: basePlan.tdee,
      bmr: basePlan.bmr,
      base_daily_calorie_target: basePlan.daily_calorie_target,
      min_calories: basePlan.min_calories,
      safe_max_calories: safeMax,
      weekly_change_kg: basePlan.weekly_change_kg,
    },
  };

  const res = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  });

  const raw = res.choices[0]?.message?.content;
  if (!raw) return basePlan;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return basePlan;
  }

  const aiTarget = Number(data.daily_calorie_target);
  const finalTarget = Number.isFinite(aiTarget)
    ? clamp(Math.round(aiTarget), basePlan.min_calories, safeMax)
    : basePlan.daily_calorie_target;
  const note = (data.note ?? "").toString().trim().slice(0, 300);

  return {
    ...basePlan,
    daily_calorie_target: finalTarget,
    note: note || basePlan.note || "Рекомендация уточнена с помощью AI.",
    source: "ai",
  };
}
