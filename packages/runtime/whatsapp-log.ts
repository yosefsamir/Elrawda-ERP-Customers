// Deliberately accept only structured lifecycle fields, never QR, page URLs or auth payloads.
export function whatsappLog(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ component: "whatsapp", event, at: new Date().toISOString(), ...fields }));
}

export function errorCode(error: unknown): string {
  const value = error as { code?: string; name?: string } | null;
  return value?.code ?? value?.name ?? typeof error;
}

export async function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export function safeFailure(error: unknown) {
  const value = error as { message?: string; stack?: string } | null;
  const clean = (text: string) => text.replace(/https?:\/\/[^\s)]+/gi, "[url]")
    .replace(/(token|secret|password|authorization|qr|code)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9_+\/=-]{40,}/g, "[redacted]").slice(0, 600);
  return { errorCode: errorCode(error), message: clean(String(value?.message ?? error)),
    stack: value?.stack?.split("\n").filter(line => /^\s+at /.test(line)).slice(0, 6).map(clean) };
}
