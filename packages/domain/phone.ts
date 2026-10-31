export type PhoneState = "valid" | "missing" | "invalid" | "not_egyptian";
export type PhoneValidation = {
  state: PhoneState;
  normalized: string | null;
  reason: string;
};

/** Shape validation only. It never implies ownership or WhatsApp registration. */
export function validateEgyptPhone(input: unknown): PhoneValidation {
  const raw = String(input ?? "").trim();
  if (!raw)
    return { state: "missing", normalized: null, reason: "لم يُسجّل رقم" };
  let value = raw
    .replace(/[٠-٩۰-۹]/g, (digit) =>
      String(digit.charCodeAt(0) - (digit <= "٩" ? 1632 : 1776)),
    )
    .replace(/[\s().-]/g, "");
  if (value.startsWith("+")) value = value.slice(1);
  if (value.startsWith("00")) value = value.slice(2);
  if (/^01[0125]\d{8}$/.test(value)) value = `20${value.slice(1)}`;
  if (/^201[0125]\d{8}$/.test(value))
    return {
      state: "valid",
      normalized: value,
      reason: "صيغة موبايل مصري صحيحة",
    };
  if (
    /^\d{10,15}$/.test(value) &&
    !value.startsWith("20") &&
    !value.startsWith("0")
  )
    return {
      state: "not_egyptian",
      normalized: null,
      reason: "صيغة دولية خارج مصر أو رقم محلي ناقص؛ يحتاج مراجعة",
    };
  return {
    state: "invalid",
    normalized: null,
    reason: "ليس موبايلًا مصريًا بصيغة صحيحة",
  };
}

export function selectPhone(
  values: unknown[],
): PhoneValidation & { raw: string; field: number } {
  const results = values.map((value, index) => ({
    ...validateEgyptPhone(value),
    raw: String(value ?? "").trim(),
    field: index + 1,
  }));
  return (
    results.find((value) => value.state === "valid") ??
    results.find((value) => value.state !== "missing") ?? {
      ...validateEgyptPhone(""),
      raw: "",
      field: 1,
    }
  );
}
export function cairoDay(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Checks if current Cairo time is within working hours (e.g. "09:00" to "21:00").
 * Used exclusively for historical/backlog customer batches.
 */
export function isWithinCairoWorkHours(
  workStart: string,
  workEnd: string,
  date = new Date(),
): boolean {
  const cairoTimeStr = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

  if (workStart <= workEnd) {
    return cairoTimeStr >= workStart && cairoTimeStr < workEnd;
  }
  return cairoTimeStr >= workStart || cairoTimeStr < workEnd;
}
