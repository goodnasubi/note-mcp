import { randomUUID } from "node:crypto";
import { Lexer, type Token, type Tokens } from "marked";

/**
 * Markdown を note のエディタが保存する形式の HTML に変換する。
 *
 * note は本文 HTML の仕様を公開していない。ここでは、エディタが出す HTML に合わせて
 * 次の方針で変換する（ブロック要素には name と id に同じ UUID を付ける）。
 *
 *   # / ##        → <h2>（大見出し）
 *   ###           → <h3>（小見出し）
 *   #### 以下      → <p><strong>…</strong></p>
 *   段落           → <p>（段落内の改行は <br>）
 *   **太字**       → <strong>
 *   [リンク](url)  → <a href>（http / https / mailto のみ）
 *   - / 1.        → <ul> / <ol>
 *   > 引用         → <blockquote>
 *   ```コード```   → <pre><code>
 *   ![alt](path)  → <figure><img><figcaption>
 *   ---           → <hr>
 *
 * note が対応しない記法は、次のように扱って warnings に理由を残す。
 *   表            → 1行ずつ「見出し: 値」の箇条書きに変換
 *   生の HTML     → 削除（HTML コメントは警告なしで削除）
 *   *斜体* / ~~取り消し~~ / `コード` → 装飾を外して文字だけ残す（警告なし）
 */

export interface ImageRef {
  /** Markdown に書かれたままの画像パス（または URL）。 */
  src: string;
  alt: string;
}

export interface ConvertOptions {
  /** Markdown の画像パス → アップロード済みの URL。ここにない画像はアップロード前として扱う。 */
  imageUrls?: ReadonlyMap<string, string>;
  /** テスト用: UUID の生成関数。 */
  newId?: () => string;
}

export interface ConvertResult {
  html: string;
  /** 本文の文字数（タグを除いた文字の数）。draft_save の body_length に使う。 */
  textLength: number;
  warnings: string[];
  images: ImageRef[];
}

/** Markdown に含まれる画像（重複なし、出現順）を返す。 */
export function collectImages(markdown: string): ImageRef[] {
  const found = new Map<string, ImageRef>();
  walkTokens(new Lexer().lex(normalize(markdown)), (token) => {
    if (token.type === "image") {
      const img = token as Tokens.Image;
      if (!found.has(img.href)) found.set(img.href, { src: img.href, alt: img.text });
    }
  });
  return [...found.values()];
}

export function isRemoteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

export function markdownToNoteHtml(markdown: string, options: ConvertOptions = {}): ConvertResult {
  const ctx: Ctx = {
    imageUrls: options.imageUrls ?? new Map(),
    newId: options.newId ?? randomUUID,
    warnings: [],
    textLength: 0,
  };
  const tokens = new Lexer().lex(normalize(markdown));
  const html = renderBlocks(tokens, ctx);
  return {
    html,
    textLength: ctx.textLength,
    warnings: dedupe(ctx.warnings),
    images: collectImages(markdown),
  };
}

interface Ctx {
  imageUrls: ReadonlyMap<string, string>;
  newId: () => string;
  warnings: string[];
  textLength: number;
}

function normalize(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n");
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function walkTokens(tokens: Token[], visit: (t: Token) => void): void {
  for (const token of tokens) {
    visit(token);
    const t = token as Token & { tokens?: Token[]; items?: Token[] };
    if (t.tokens) walkTokens(t.tokens, visit);
    if (t.items) walkTokens(t.items, visit);
    if (token.type === "table") {
      const table = token as Tokens.Table;
      for (const cell of table.header) walkTokens(cell.tokens, visit);
      for (const row of table.rows) for (const cell of row) walkTokens(cell.tokens, visit);
    }
  }
}

// ---- ブロック要素 ----

function open(tag: string, ctx: Ctx): string {
  const id = ctx.newId();
  return `<${tag} name="${id}" id="${id}">`;
}

function renderBlocks(tokens: Token[], ctx: Ctx): string {
  return tokens.map((t) => renderBlock(t, ctx)).join("");
}

function renderBlock(token: Token, ctx: Ctx): string {
  switch (token.type) {
    case "space":
      return "";
    case "heading": {
      const h = token as Tokens.Heading;
      const tag = h.depth <= 2 ? "h2" : h.depth === 3 ? "h3" : "p";
      const headingOpen = open(tag, ctx);
      const inner = renderInline(h.tokens, ctx);
      return tag === "p" ? `${headingOpen}<strong>${inner}</strong></p>` : `${headingOpen}${inner}</${tag}>`;
    }
    case "paragraph":
      return renderParagraph((token as Tokens.Paragraph).tokens, ctx);
    case "text": {
      // リストの中などで、段落にくるまれずに出てくるテキスト
      const t = token as Tokens.Text;
      return renderParagraph(t.tokens ?? [t], ctx);
    }
    case "list":
      return renderList(token as Tokens.List, ctx);
    case "blockquote": {
      const quoteOpen = open("blockquote", ctx);
      return `${quoteOpen}${renderBlocks((token as Tokens.Blockquote).tokens, ctx)}</blockquote>`;
    }
    case "code": {
      const code = (token as Tokens.Code).text;
      ctx.textLength += [...code].length;
      return `${open("pre", ctx)}<code>${escapeHtml(code)}</code></pre>`;
    }
    case "hr":
      return "<hr>";
    case "table":
      return renderTable(token as Tokens.Table, ctx);
    case "html": {
      const raw = (token as Tokens.HTML).text.trim();
      if (!/^<!--[\s\S]*-->$/.test(raw)) {
        ctx.warnings.push(`HTML は note では使えないため削除しました: ${truncate(raw, 60)}`);
      }
      return "";
    }
    case "def":
      return "";
    default:
      ctx.warnings.push(`未対応の Markdown 要素を削除しました: ${token.type}`);
      return "";
  }
}

/**
 * 段落を描画する。画像は note ではブロック要素（figure）なので、
 * 段落の途中に画像があれば、そこで段落を分ける。
 */
function renderParagraph(tokens: Token[], ctx: Ctx): string {
  const out: string[] = [];
  let run: Token[] = [];
  const flush = () => {
    const inner = renderInline(run, ctx).replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/g, "");
    if (inner.trim()) out.push(`${open("p", ctx)}${inner}</p>`);
    run = [];
  };
  for (const t of tokens) {
    if (t.type === "image") {
      flush();
      out.push(renderImage(t as Tokens.Image, ctx));
    } else {
      run.push(t);
    }
  }
  flush();
  return out.join("");
}

function renderImage(img: Tokens.Image, ctx: Ctx): string {
  const url = ctx.imageUrls.get(img.href);
  if (!url && isRemoteUrl(img.href)) {
    ctx.warnings.push(`外部 URL の画像はアップロードされないため、リンクにしました: ${img.href}`);
    const label = img.text || img.href;
    ctx.textLength += [...label].length;
    return `${open("p", ctx)}<a href="${escapeAttr(img.href)}">${escapeHtml(label)}</a></p>`;
  }
  // url がない = アップロード前（dry_run）。src にはローカルパスをそのまま入れておく。
  const src = url ?? img.href;
  const id = ctx.newId();
  const caption = img.text ? `<figcaption>${escapeHtml(img.text)}</figcaption>` : "<figcaption></figcaption>";
  ctx.textLength += [...img.text].length;
  return `<figure name="${id}" id="${id}"><img src="${escapeAttr(src)}" alt="" width="620" height="auto">${caption}</figure>`;
}

function renderList(list: Tokens.List, ctx: Ctx): string {
  const tag = list.ordered ? "ol" : "ul";
  const start = list.ordered && typeof list.start === "number" && list.start !== 1 ? ` start="${list.start}"` : "";
  const listOpen = open(tag, ctx).replace(/>$/, `${start}>`);
  const items = list.items
    .map((item) => {
      const liOpen = open("li", ctx);
      const parts: string[] = [];
      const inline: string[] = [];
      for (const child of item.tokens) {
        if (child.type === "list") {
          parts.push(renderList(child as Tokens.List, ctx));
        } else if (child.type === "text" || child.type === "paragraph") {
          const c = child as Tokens.Text | Tokens.Paragraph;
          inline.push(renderInline(c.tokens ?? [c], ctx));
        } else if (child.type === "space" || child.type === "checkbox") {
          continue;
        } else {
          // リスト内のコードブロックや引用などはブロックとして並べる
          parts.push(renderBlock(child, ctx));
        }
      }
      const checkbox = item.task ? (item.checked ? "☑ " : "☐ ") : "";
      return `${liOpen}${checkbox}${inline.join("<br>")}${parts.join("")}</li>`;
    })
    .join("");
  return `${listOpen}${items}</${tag}>`;
}

function renderTable(table: Tokens.Table, ctx: Ctx): string {
  ctx.warnings.push("表は note で使えないため、1行ずつ箇条書きに変換しました。note の画面で確認してください。");
  const listOpen = open("ul", ctx);
  const headers = table.header.map((h) => renderInline(h.tokens, ctx));
  const items = table.rows
    .map((row) => {
      const cells = row.map((cell, i) => {
        const value = renderInline(cell.tokens, ctx);
        const header = headers[i];
        return header ? `${header}: ${value}` : value;
      });
      return `${open("li", ctx)}${cells.join(" / ")}</li>`;
    })
    .join("");
  return `${listOpen}${items}</ul>`;
}

// ---- インライン要素 ----

function renderInline(tokens: Token[], ctx: Ctx): string {
  return tokens.map((t) => renderInlineToken(t, ctx)).join("");
}

function renderInlineToken(token: Token, ctx: Ctx): string {
  switch (token.type) {
    case "text": {
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) return renderInline(t.tokens, ctx);
      return text(t.text, ctx);
    }
    case "escape":
      return text((token as Tokens.Escape).text, ctx);
    case "strong":
      return `<strong>${renderInline((token as Tokens.Strong).tokens, ctx)}</strong>`;
    case "em":
      return renderInline((token as Tokens.Em).tokens, ctx);
    case "del":
      return renderInline((token as Tokens.Del).tokens, ctx);
    case "codespan":
      return text((token as Tokens.Codespan).text, ctx);
    case "br":
      return "<br>";
    case "link": {
      const link = token as Tokens.Link;
      const inner = renderInline(link.tokens, ctx);
      if (!/^(https?:|mailto:)/i.test(link.href)) {
        ctx.warnings.push(`http / https / mailto 以外のリンクは文字だけにしました: ${link.href}`);
        return inner;
      }
      return `<a href="${escapeAttr(link.href)}">${inner}</a>`;
    }
    case "image": {
      // 見出しやリストの中の画像。figure は置けないので、代替テキストだけ残す。
      const img = token as Tokens.Image;
      ctx.warnings.push(`見出しやリストの中の画像は note に置けないため、代替テキストにしました: ${img.href}`);
      return text(img.text, ctx);
    }
    case "html": {
      const raw = (token as Tokens.Tag).text;
      if (/^<br\s*\/?>$/i.test(raw)) return "<br>";
      if (!/^<!--/.test(raw)) ctx.warnings.push(`HTML は note では使えないため削除しました: ${truncate(raw, 60)}`);
      return "";
    }
    default:
      return text((token as { raw?: string }).raw ?? "", ctx);
  }
}

function text(value: string, ctx: Ctx): string {
  // 段落内の改行（ソフト改行）は、note では <br> にする
  const lines = value.split("\n");
  ctx.textLength += lines.reduce((n, l) => n + [...l].length, 0);
  return lines.map(escapeHtml).join("<br>");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
