export function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

/** Нормализация КБЖУ для записи в БД. */
export function normalizeMacros(obj) {
  return {
    calories: Math.round(clamp(obj.calories, 0, 15000)),
    protein_g: clamp(obj.protein_g, 0, 1000),
    fat_g: clamp(obj.fat_g, 0, 1000),
    carbs_g: clamp(obj.carbs_g, 0, 2000),
  };
}
