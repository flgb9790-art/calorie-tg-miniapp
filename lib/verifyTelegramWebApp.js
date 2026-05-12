import crypto from "crypto";

/**
 * Проверка подписи Telegram Web App (initData).
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyTelegramWebAppInitData(initData, botToken) {
  if (!initData || !botToken) return { ok: false, reason: "missing" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no_hash" };

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    pairs.push([key, value]);
  }
  pairs.sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculated = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculated !== hash) return { ok: false, reason: "bad_hash" };

  const authDate = Number(params.get("auth_date"));
  if (Number.isFinite(authDate)) {
    const ageSec = Math.floor(Date.now() / 1000) - authDate;
    if (ageSec > 24 * 60 * 60) return { ok: false, reason: "stale" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "no_user" };

  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: "user_json" };
  }

  if (!user?.id) return { ok: false, reason: "no_user_id" };

  return { ok: true, user };
}
