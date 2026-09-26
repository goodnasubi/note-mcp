# note-draft-mcp

Claude などの MCP クライアントから、**自分の note.com アカウントに記事を「下書き保存」する** MCP サーバーです（stdio）。

Markdown を note のエディタ用の HTML に変換し、ローカル画像のアップロード、見出し画像の設定までを行います。

> [!WARNING]
> - **note の非公式 API を使っています。** note に公式の投稿 API はありません。ブラウザのエディタが使っている内部 API を呼んでいるため、仕様が変わると予告なく動かなくなります。
> - **note の利用規約上のリスクがあります。** 規約は自動化された手段でのアクセスを制限しています。アカウントの利用停止などの可能性も含め、[ご利用規約](https://terms.help-note.com/hc/ja/articles/44943817565465) を自分で確認し、自己責任で使ってください。使うのは自分のアカウントだけにし、短時間に大量のリクエストを送らないでください。
> - **公開はできません。** このサーバーは下書き保存専用です。公開・削除・価格設定の API は、コード上で呼べないように制限しています。公開は、note の画面で内容を確認してから手で行ってください。

## ツール

| ツール | 内容 |
|---|---|
| `create_draft` | Markdown から新しい下書きを作る。ローカル画像は自動でアップロードして埋め込む。`eyecatch_path` で見出し画像も設定できる。`dry_run: true` なら何も送らずに内容だけ返す |
| `update_draft` | 既存の下書きのタイトルと本文を丸ごと置き換える。**下書き一覧にある ID だけ**を受け付ける（公開済みの記事は更新しない） |
| `upload_image` | 画像をアップロードし、URL を返す |
| `set_eyecatch` | 既存の下書きに見出し画像を設定する |
| `list_drafts` | 自分の下書きの一覧（ID・タイトル・編集画面の URL） |

`create_draft` / `update_draft` の引数:

- `title`: 省略すると、Markdown の先頭にある `# 見出し` をタイトルにし、本文からは除きます。
- `markdown` または `markdown_path`: どちらか一方を指定します。
- `base_dir`: 画像の相対パスの基準です。省略時は `markdown_path` のあるディレクトリになります。
- `eyecatch_path`: 見出し画像のファイルです。
- `dry_run`: 送信前に内容を確認するためのフラグです。タイトル、本文 HTML の先頭、画像の数、警告を返します。

画像は PNG / JPEG / GIF で、10MB までです。

## 必要なもの

- Node.js 20 以上
- note.com にログインしたブラウザ（Cookie を取り出すため）

## インストール

```sh
git clone https://github.com/goodnasubi/note-mcp.git
cd note-mcp
npm ci
npm run build
```

## Cookie の取得と扱い

1. ブラウザで note.com にログインします。
2. 開発者ツールを開きます（F12）。Chrome では「Application」→「Cookies」→ `https://note.com` を選びます。
3. `_note_session_v5` の **値** をコピーします。
4. 環境変数 `NOTE_SESSION_COOKIE` に設定します。

```sh
export NOTE_SESSION_COOKIE='コピーした値'
```

`NOTE_SESSION_COOKIE` には、Cookie ヘッダー全体（`_note_session_v5=...; XSRF-TOKEN=...`）も入れられます。`XSRF-TOKEN` が含まれていれば、`X-XSRF-TOKEN` ヘッダーとして自動で送ります。別に指定したい場合は `NOTE_XSRF_TOKEN` を使ってください。

> [!CAUTION]
> この Cookie は **パスワードと同じ** です。持っている人は、あなたとして note を操作できます。
> - リポジトリ、Issue、チャット、スクリーンショットに貼らないでください。`.env` は `.gitignore` 済みです。
> - 漏れたと思ったら、note からログアウトしてください。セッションが無効になります。
> - Cookie には有効期限があります。期限が切れると、ツールは `NoteAuthError` を返します。取り直して設定し直してください。

## MCP クライアントへの登録

### Claude Code

Cookie を設定ファイルに書かずに済むよう、シェルの環境変数から渡す方法をおすすめします。

```sh
export NOTE_SESSION_COOKIE='...'   # シェルの設定や direnv などで設定しておく
claude mcp add note-draft -- node /path/to/note-mcp/dist/index.js
```

`-e` で渡すこともできますが、その場合は Cookie が Claude Code の設定ファイルに保存されます。

```sh
claude mcp add note-draft -e NOTE_SESSION_COOKIE='...' -- node /path/to/note-mcp/dist/index.js
```

### Claude Code on the web（クラウドセッション）

1. 環境設定のシークレットに `NOTE_SESSION_COOKIE` を登録します。
2. ネットワークの許可リストに `note.com`、`editor.note.com`、画像の配信・アップロード先（`assets.st-note.com` と、画像アップロード時に使うストレージのホスト）を追加します。

### Claude Desktop

`claude_desktop_config.json` に追加します。Cookie は設定ファイルに平文で保存されるので、ファイルの扱いに注意してください。

```json
{
  "mcpServers": {
    "note-draft": {
      "command": "node",
      "args": ["/path/to/note-mcp/dist/index.js"],
      "env": { "NOTE_SESSION_COOKIE": "..." }
    }
  }
}
```

## 使い方の例

Claude に、たとえば次のように頼みます。

> `docs/articles/2026-09-26-example.md` を、見出し画像 `docs/articles/images/header.png` で note に下書き保存して。先に dry_run で確認して。

返ってきた `edit_url` を開いて内容を確認し、問題がなければ note の画面から公開します。

## Markdown の変換

| Markdown | note |
|---|---|
| `#` / `##` | 大見出し |
| `###` | 小見出し |
| `####` 以下 | 太字の段落 |
| 段落・段落内の改行 | 段落・改行 |
| `**太字**` | 太字 |
| `[リンク](https://...)` | リンク（http / https / mailto のみ） |
| `-` / `1.` | 箇条書き / 番号付きリスト |
| `>` | 引用 |
| ```` ``` ```` | コードブロック |
| `![説明](images/x.png)` | 画像（アップロードして埋め込む。説明はキャプションになる） |
| `---` | 区切り線 |
| 表 | **非対応**。1行ずつ「見出し: 値」の箇条書きに変換し、警告を返す |
| 生の HTML | 削除して警告を返す（HTML コメントは警告なしで削除） |
| `*斜体*`、`~~取り消し~~`、`` `コード` `` | 装飾を外し、文字だけ残す |
| 外部 URL の画像 | アップロードせず、リンクにして警告を返す |
| YAML front matter | 削除する |

## 使っている API（非公式）

| 用途 | API |
|---|---|
| 認証の確認 | `GET /api/v2/current_user` |
| 記事の作成 | `POST /api/v1/text_notes` |
| 下書き保存 | `POST /api/v1/text_notes/draft_save?id={id}&is_temp_saved=true` |
| 下書き一覧 | `GET /api/v2/note_list/contents?status=draft` |
| 画像アップロード | `POST /api/v3/images/upload/presigned_post` → ストレージへ POST |
| 見出し画像 | `POST /api/v1/image_upload/note_eyecatch` |

呼べる API は `src/note-client.ts` の `ALLOWED_ENDPOINTS` に限定しています。

エンドポイントは、次の MIT ライセンスの実装を参考に調べました。

- [TaisukeAndo/note-mcp](https://github.com/TaisukeAndo/note-mcp)
- [shimayuz/note-com-mcp](https://github.com/shimayuz/note-com-mcp)

## 開発

```sh
npm test          # 単体テスト・結合テスト（HTTP はモック。note には接続しない）
npm run typecheck
npm run build
```

## ライセンス

MIT
