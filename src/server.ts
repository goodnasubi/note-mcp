import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadAuth } from "./config.js";
import { createDraft, dryRun, prepareArticle, setEyecatch, updateDraft, uploadImageFile } from "./drafts.js";
import { ConfigError, InputError, NoteApiError, NoteAuthError } from "./errors.js";
import { NoteClient } from "./note-client.js";

export const SERVER_NAME = "note-draft-mcp";
export const SERVER_VERSION = "0.1.0";

export interface ServerDeps {
  /** テスト用: NoteClient の作り方を差し替える。 */
  createClient?: () => NoteClient;
}

const articleShape = {
  title: z.string().optional().describe("記事タイトル。省略すると Markdown 先頭の「# 見出し」を使い、本文からは除く。"),
  markdown: z.string().optional().describe("本文の Markdown。markdown_path と同時には指定できない。"),
  markdown_path: z.string().optional().describe("本文の Markdown ファイルのパス（.md）。"),
  base_dir: z
    .string()
    .optional()
    .describe("画像の相対パスの基準ディレクトリ。省略時は markdown_path のディレクトリ、なければカレントディレクトリ。"),
  eyecatch_path: z.string().optional().describe("見出し画像にするファイル（PNG / JPEG / GIF、10MB まで）。base_dir 基準。"),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe("true なら note に何も送らず、送る予定の内容（タイトル・本文 HTML の先頭・画像数・警告）だけを返す。"),
};

export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const client = () => (deps.createClient ? deps.createClient() : new NoteClient(loadAuth()));

  server.registerTool(
    "create_draft",
    {
      title: "note に下書きを作成",
      description:
        "Markdown を note 用の HTML に変換し、自分の note アカウントに新しい下書きとして保存する。公開はしない（公開は note の画面から手動で行う）。ローカル画像は自動でアップロードして埋め込む。まず dry_run: true で内容を確認することを勧める。",
      inputSchema: articleShape,
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const article = await prepareArticle(toArticleInput(args));
        if (args.dry_run) return dryRun(article);
        return createDraft(client(), article);
      }),
  );

  server.registerTool(
    "update_draft",
    {
      title: "note の下書きを更新",
      description:
        "既存の下書きのタイトルと本文を、指定した Markdown で丸ごと置き換える。公開済みの記事は更新できない（下書き一覧にある ID だけ受け付ける）。公開はしない。",
      inputSchema: {
        id: z.string().regex(/^\d+$/, "数字の ID を指定してください").describe("下書きの ID（create_draft / list_drafts が返す数字の id）。"),
        ...articleShape,
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const article = await prepareArticle(toArticleInput(args));
        if (args.dry_run) return { id: args.id, ...dryRun(article) };
        return updateDraft(client(), args.id, article);
      }),
  );

  server.registerTool(
    "upload_image",
    {
      title: "note に画像をアップロード",
      description:
        "ローカルの画像（PNG / JPEG / GIF、10MB まで）を note にアップロードし、本文に埋め込める URL を返す。通常は create_draft が自動で行うので、単体で使う必要はあまりない。",
      inputSchema: { path: z.string().describe("画像ファイルのパス。") },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => run(() => uploadImageFile(client(), args.path)),
  );

  server.registerTool(
    "set_eyecatch",
    {
      title: "下書きの見出し画像を設定",
      description: "既存の下書きに見出し画像（アイキャッチ）を設定する。下書き一覧にある ID だけ受け付ける。",
      inputSchema: {
        id: z.string().regex(/^\d+$/, "数字の ID を指定してください").describe("下書きの ID。"),
        path: z.string().describe("画像ファイルのパス（PNG / JPEG / GIF、10MB まで）。"),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => run(() => setEyecatch(client(), args.id, args.path)),
  );

  server.registerTool(
    "list_drafts",
    {
      title: "自分の下書き一覧",
      description: "自分の note の下書きを新しい順に返す（ID・タイトル・編集画面の URL）。",
      inputSchema: {
        page: z.number().int().min(1).optional().default(1).describe("ページ番号（1 から）。"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => client().listDrafts(args.page)),
  );

  return server;
}

function toArticleInput(args: {
  title?: string | undefined;
  markdown?: string | undefined;
  markdown_path?: string | undefined;
  base_dir?: string | undefined;
  eyecatch_path?: string | undefined;
}) {
  return {
    title: args.title,
    markdown: args.markdown,
    markdownPath: args.markdown_path,
    baseDir: args.base_dir,
    eyecatchPath: args.eyecatch_path,
  };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: describeError(err) }] };
  }
}

export function describeError(err: unknown): string {
  if (err instanceof ConfigError || err instanceof NoteAuthError || err instanceof InputError) {
    return `${err.name}: ${err.message}`;
  }
  if (err instanceof NoteApiError) {
    return `${err.name}: ${err.message}\nnote の非公式 API の仕様が変わった可能性があります。`;
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "note.com への通信がタイムアウトしました。時間をおいて再実行してください。";
  }
  return `予期しないエラー: ${err instanceof Error ? err.message : String(err)}`;
}
