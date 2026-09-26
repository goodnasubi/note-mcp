import type { NoteAuth } from "./config.js";
import { InputError, NoteApiError, NoteAuthError } from "./errors.js";

/**
 * note.com の非公式 API クライアント（下書き専用）。
 *
 * note に公式 API はない。ここで使うのは、ブラウザのエディタが使っている内部 API で、
 * 仕様は予告なく変わりうる。エンドポイントは次の公開実装・記事を参考にした（いずれも MIT）。
 *   - https://github.com/TaisukeAndo/note-mcp
 *   - https://github.com/shimayuz/note-com-mcp
 *
 * 誤って公開しないよう、呼べる API を ALLOWED_ENDPOINTS に限定している。
 * 公開・削除・価格設定など、下書き保存以外の API はこのクライアントからは呼べない。
 */

export const NOTE_ORIGIN = "https://note.com";
export const EDITOR_ORIGIN = "https://editor.note.com";

const ALLOWED_ENDPOINTS: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/api\/v2\/current_user$/ },
  { method: "GET", path: /^\/api\/v2\/note_list\/contents$/ },
  { method: "POST", path: /^\/api\/v1\/text_notes$/ },
  { method: "POST", path: /^\/api\/v1\/text_notes\/draft_save$/ },
  { method: "POST", path: /^\/api\/v3\/images\/upload\/presigned_post$/ },
  { method: "POST", path: /^\/api\/v1\/image_upload\/note_eyecatch$/ },
];

export const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 30_000;
const SNIPPET_LENGTH = 300;

export interface CurrentUser {
  id: string;
  urlname: string;
}

export interface NoteRef {
  id: string;
  key: string;
}

export interface DraftSummary extends NoteRef {
  title: string;
  status: string;
  updatedAt?: string;
  editUrl: string;
}

export interface DraftContent {
  title: string;
  html: string;
  textLength: number;
}

export interface ImageFile {
  fileName: string;
  mimeType: string;
  data: Uint8Array<ArrayBuffer>;
}

type FetchLike = typeof fetch;

export class NoteClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly auth: NoteAuth,
    options: { fetch?: FetchLike } = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  static editUrl(key: string): string {
    return `${EDITOR_ORIGIN}/notes/${encodeURIComponent(key)}/edit/`;
  }

  /** Cookie が有効かを確かめ、ログイン中のユーザーを返す。 */
  async getCurrentUser(): Promise<CurrentUser> {
    const json = await this.requestJson("GET", "/api/v2/current_user");
    const data = asRecord(asRecord(json).data);
    if (data.id === undefined || data.id === null) {
      // 未ログインのとき、200 で data が空になることがある
      throw new NoteAuthError();
    }
    return { id: String(data.id), urlname: String(data.urlname ?? "") };
  }

  /** 空の記事を作る。この時点では note 上では「下書き」にもなっていない。 */
  async createNote(title: string): Promise<NoteRef> {
    const json = await this.requestJson("POST", "/api/v1/text_notes", {
      json: { body: "<p></p>", body_length: 0, name: title, index: false, is_lead_form: false },
    });
    const data = asRecord(asRecord(json).data);
    if (data.id === undefined || data.id === null || !data.key) {
      throw new NoteApiError(
        "記事は作成されましたが、応答から ID を読み取れませんでした。note 側の仕様が変わった可能性があります",
        200,
        snippet(JSON.stringify(json)),
      );
    }
    return { id: String(data.id), key: String(data.key) };
  }

  /** タイトルと本文を下書きとして保存する（公開はしない）。 */
  async saveDraft(id: string, content: DraftContent): Promise<void> {
    assertNumericId(id);
    await this.requestJson("POST", "/api/v1/text_notes/draft_save", {
      query: { id, is_temp_saved: "true" },
      json: {
        name: content.title,
        body: content.html,
        body_length: content.textLength,
        index: false,
        is_lead_form: false,
      },
    });
  }

  /** 自分の下書きを新しい順に返す。 */
  async listDrafts(page = 1, perPage = 20): Promise<{ drafts: DraftSummary[]; isLastPage: boolean }> {
    const json = await this.requestJson("GET", "/api/v2/note_list/contents", {
      query: {
        page: String(page),
        per_page: String(perPage),
        draft: "true",
        draft_reedit: "false",
        status: "draft",
      },
    });
    const data = asRecord(asRecord(json).data);
    const notes = Array.isArray(data.notes) ? data.notes : [];
    const drafts = notes
      .map((n) => asRecord(n))
      .filter((n) => n.status === "draft")
      .map((n): DraftSummary => {
        const draft = asRecord(n.noteDraft);
        const key = String(n.key ?? "");
        const summary: DraftSummary = {
          id: String(n.id ?? ""),
          key,
          title: String(n.name || draft.name || "(無題)"),
          status: String(n.status),
          editUrl: NoteClient.editUrl(key),
        };
        const updatedAt = n.updatedAt ?? n.updated_at ?? draft.updatedAt ?? draft.updated_at;
        if (updatedAt) summary.updatedAt = String(updatedAt);
        return summary;
      });
    const lastFlag = data.isLastPage ?? data.is_last_page;
    const isLastPage = typeof lastFlag === "boolean" ? lastFlag : notes.length < perPage;
    return { drafts, isLastPage };
  }

  /**
   * 指定した ID の記事が、自分の「下書き」であることを確かめる。
   * 公開済みの記事を上書きしないためのガード。
   */
  async findDraft(id: string, maxPages = 10): Promise<DraftSummary> {
    assertNumericId(id);
    for (let page = 1; page <= maxPages; page++) {
      const { drafts, isLastPage } = await this.listDrafts(page, 50);
      const hit = drafts.find((d) => d.id === id);
      if (hit) return hit;
      if (isLastPage) break;
    }
    throw new InputError(
      `ID ${id} の下書きが見つかりません。公開済みの記事や他人の記事は更新できません（list_drafts で ID を確認してください）。`,
    );
  }

  /** 本文用の画像をアップロードし、本文に埋め込む URL を返す。 */
  async uploadImage(file: ImageFile): Promise<string> {
    const form = new FormData();
    form.append("filename", file.fileName);
    const json = await this.requestJson("POST", "/api/v3/images/upload/presigned_post", { form });
    const data = asRecord(asRecord(json).data);
    const post = asRecord(data.post);
    const action = typeof data.action === "string" ? data.action : "";
    const url = typeof data.url === "string" ? data.url : "";
    if (!action || !url || Object.keys(post).length === 0) {
      throw new NoteApiError("画像アップロード用の URL を取得できませんでした", 200, snippet(JSON.stringify(json)));
    }
    if (!/^https:\/\//.test(action)) {
      throw new NoteApiError("画像のアップロード先が https ではありません", 200, snippet(action));
    }

    // S3 の POST ポリシーでは、フィールドを全部送り、file を最後に置く必要がある
    const s3Form = new FormData();
    for (const [k, v] of Object.entries(post)) {
      if (v !== null && v !== undefined && v !== "") s3Form.append(k, String(v));
    }
    s3Form.append("file", new Blob([file.data], { type: file.mimeType }), file.fileName);
    const res = await this.fetchImpl(action, {
      method: "POST",
      body: s3Form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // S3 には Cookie を送らない。応答にも秘密情報は含まれない
      throw new NoteApiError("画像ストレージへのアップロードに失敗しました", res.status, snippet(await safeText(res)));
    }
    return url;
  }

  /** 下書きに見出し画像（アイキャッチ）を設定し、画像の URL を返す。 */
  async uploadEyecatch(id: string, file: ImageFile): Promise<string> {
    assertNumericId(id);
    const form = new FormData();
    form.append("note_id", id);
    form.append("file", new Blob([file.data], { type: file.mimeType }), file.fileName);
    const json = await this.requestJson("POST", "/api/v1/image_upload/note_eyecatch", { form });
    const data = asRecord(asRecord(json).data);
    const url = data.url ?? data.eyecatch ?? data.eyecatch_url;
    if (typeof url !== "string" || !url) {
      throw new NoteApiError("見出し画像は送れましたが、応答に URL がありませんでした", 200, snippet(JSON.stringify(json)));
    }
    return url;
  }

  // ---- 共通 ----

  private async requestJson(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, string>; json?: unknown; form?: FormData } = {},
  ): Promise<unknown> {
    if (!ALLOWED_ENDPOINTS.some((e) => e.method === method && e.path.test(path))) {
      // 下書き専用であることを保証するためのガード。ここに来るのはバグ
      throw new Error(`許可されていない API です: ${method} ${path}`);
    }
    const url = new URL(path, NOTE_ORIGIN);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);

    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Origin: EDITOR_ORIGIN,
      Referer: `${EDITOR_ORIGIN}/`,
      Cookie: this.auth.cookieHeader,
    };
    if (this.auth.xsrfToken) headers["X-XSRF-TOKEN"] = this.auth.xsrfToken;
    let body: string | FormData | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.form) {
      body = options.form; // Content-Type（boundary 付き）は fetch に任せる
    }

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await safeText(res);

    if (res.status === 401 || res.status === 403) throw new NoteAuthError(undefined, res.status);
    // 未ログインだとログイン画面へリダイレクトされることがある
    if (res.status >= 300 && res.status < 400) throw new NoteAuthError(undefined, res.status);
    if (!res.ok) {
      throw new NoteApiError(`note API の呼び出しに失敗しました: ${method} ${path}`, res.status, snippet(text));
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (/^\s*</.test(text)) throw new NoteAuthError(undefined, res.status);
      throw new NoteApiError(`note API の応答が JSON ではありません: ${method} ${path}`, res.status, snippet(text));
    }
  }
}

function assertNumericId(id: string): void {
  if (!/^\d+$/.test(id)) throw new InputError(`記事 ID は数字で指定してください: ${id}`);
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function snippet(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > SNIPPET_LENGTH ? `${oneLine.slice(0, SNIPPET_LENGTH)}…` : oneLine;
}
