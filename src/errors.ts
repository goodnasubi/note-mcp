/**
 * エラー型。どのメッセージにも Cookie の値を含めないこと。
 */

/** 設定（環境変数）の不足・不正。 */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Cookie が未設定・期限切れ・無効で、note に認証されなかった。 */
export class NoteAuthError extends Error {
  override name = "NoteAuthError";
  constructor(
    message = "note.com に認証されませんでした。NOTE_SESSION_COOKIE が期限切れか無効です。ブラウザで note.com にログインし直し、Cookie を取り直してください。",
    readonly status?: number,
  ) {
    super(message);
  }
}

/** note の API が想定外の応答を返した。 */
export class NoteApiError extends Error {
  override name = "NoteApiError";
  constructor(
    message: string,
    readonly status: number,
    /** 応答本文の先頭（デバッグ用）。 */
    readonly bodySnippet: string,
  ) {
    super(`${message} (HTTP ${status})${bodySnippet ? `: ${bodySnippet}` : ""}`);
  }
}

/** 呼び出し側の入力が不正（ファイルがない、下書きでない、など）。 */
export class InputError extends Error {
  override name = "InputError";
}
