const KCAL_PER_KG = 7700;
const ACTIVITY_FACTOR = 1.2;
const MAX_SAFE_KG_PER_WEEK = 1;

function minCaloriesByGender(gender) {
  return gender === "male" ? 1500 : 1200;
}

/**
 * Расчёт плана калорий по Mifflin–St Jeor и цели веса.
 * Если заданы целевой вес и срок, используем их; иначе — старую эвристику по goal.
 */
export function computeCaloriePlan({
  age,
  height_cm,
  weight_kg,
  gender,
  goal,
  target_weight_kg,
  target_weeks,
}) {
  const w = Number(weight_kg);
  const h = Number(height_cm);
  const a = Number(age);
  const targetWeight =
    target_weight_kg == null || target_weight_kg === "" ? null : Number(target_weight_kg);
  const targetWeeks =
    target_weeks == null || target_weeks === "" ? null : Number(target_weeks);

  if (![w, h, a].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("invalid_profile");
  }

  let bmr;
  if (gender === "male") bmr = 10 * w + 6.25 * h - 5 * a + 5;
  else bmr = 10 * w + 6.25 * h - 5 * a - 161;

  const tdee = bmr * ACTIVITY_FACTOR;
  const minCalories = minCaloriesByGender(gender);

  let dailyTarget = Math.round(tdee);
  let weeklyChangeKg = 0;
  let targetMode = "goal";
  let note = null;

  const hasTimelineTarget =
    Number.isFinite(targetWeight) &&
    Number.isFinite(targetWeeks) &&
    targetWeeks > 0;

  if (hasTimelineTarget) {
    const deltaKg = w - targetWeight;
    weeklyChangeKg = deltaKg / targetWeeks;
    targetMode = "timeline";

    if (deltaKg > 0) {
      const safeWeeklyLossKg = Math.min(weeklyChangeKg, MAX_SAFE_KG_PER_WEEK);
      const dailyDeficit = (safeWeeklyLossKg * KCAL_PER_KG) / 7;
      dailyTarget = Math.round(tdee - dailyDeficit);
      if (weeklyChangeKg > MAX_SAFE_KG_PER_WEEK) {
        note = "Слишком быстрый темп снижения веса. Ограничили расчёт до безопасного уровня.";
      }
    } else if (deltaKg < 0) {
      const dailySurplus = (Math.abs(weeklyChangeKg) * KCAL_PER_KG) / 7;
      dailyTarget = Math.round(tdee + dailySurplus);
    } else {
      dailyTarget = Math.round(tdee);
    }
  } else {
    if (goal === "lose") dailyTarget = Math.round(tdee - 500);
    else if (goal === "gain") dailyTarget = Math.round(tdee + 300);
    else dailyTarget = Math.round(tdee);
  }

  if (dailyTarget < minCalories) {
    dailyTarget = minCalories;
    if (!note) {
      note = "Расчёт упёрся в безопасный минимум по калориям.";
    }
  }

  return {
    daily_calorie_target: dailyTarget,
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    min_calories: minCalories,
    weekly_change_kg: Math.round(weeklyChangeKg * 100) / 100,
    target_mode: targetMode,
    note,
  };
}

export function computeDailyCalorieTarget(input) {
  return computeCaloriePlan(input).daily_calorie_target;
}
