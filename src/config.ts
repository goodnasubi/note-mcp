import { ConfigError } from "./errors.js";

export const SESSION_COOKIE_NAME = "_note_session_v5";

export interface NoteAuth {
  /** そのまま Cookie ヘッダーに入れる文字列。 */
  cookieHeader: string;
  /** Cookie に XSRF-TOKEN が含まれていれば、その値（X-XSRF-TOKEN ヘッダーで送る）。 */
  xsrfToken?: string;
}

/**
 * 環境変数から認証情報を読む。
 *
 * NOTE_SESSION_COOKIE には次のどちらかを入れる。
 *   - `_note_session_v5` の値だけ
 *   - ブラウザの Cookie ヘッダーそのもの（`_note_session_v5=...; XSRF-TOKEN=...` など）
 * NOTE_XSRF_TOKEN を別に指定した場合は、そちらを優先する。
 */
export function loadAuth(env: NodeJS.ProcessEnv = process.env): NoteAuth {
  const raw = env.NOTE_SESSION_COOKIE?.trim();
  if (!raw) {
    throw new ConfigError(
      "環境変数 NOTE_SESSION_COOKIE が設定されていません。ブラウザで note.com にログインし、Cookie `_note_session_v5` の値を設定してください（README 参照）。",
    );
  }
  if (/[\r\n]/.test(raw)) {
    throw new ConfigError("NOTE_SESSION_COOKIE に改行が含まれています。値を1行で設定してください。");
  }

  const auth = raw.includes("=") ? parseCookieHeader(raw) : { cookieHeader: `${SESSION_COOKIE_NAME}=${raw}` };
  const xsrf = env.NOTE_XSRF_TOKEN?.trim();
  if (xsrf) auth.xsrfToken = xsrf;
  return auth;
}

function parseCookieHeader(header: string): NoteAuth {
  const pairs = header
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  const map = new Map<string, string>();
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  if (!map.get(SESSION_COOKIE_NAME)) {
    throw new ConfigError(
      `NOTE_SESSION_COOKIE に ${SESSION_COOKIE_NAME} が含まれていません。値だけ、または "${SESSION_COOKIE_NAME}=..." を含む Cookie ヘッダーを設定してください。`,
    );
  }
  const auth: NoteAuth = { cookieHeader: pairs.join("; ") };
  const xsrf = map.get("XSRF-TOKEN");
  if (xsrf) auth.xsrfToken = safeDecode(xsrf);
  return auth;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
