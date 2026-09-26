import { describe, expect, it } from "vitest";
import { collectImages, markdownToNoteHtml } from "../src/markdown.js";

function convert(md: string, imageUrls?: Map<string, string>) {
  let n = 0;
  return markdownToNoteHtml(md, { newId: () => `u${++n}`, ...(imageUrls ? { imageUrls } : {}) });
}

describe("markdownToNoteHtml", () => {
  it("段落と太字・リンクを変換し、ブロックに name/id を付ける", () => {
    const r = convert("本文 **太字** と [リンク](https://example.com)");
    expect(r.html).toBe(
      '<p name="u1" id="u1">本文 <strong>太字</strong> と <a href="https://example.com">リンク</a></p>',
    );
    expect(r.warnings).toEqual([]);
  });

  it("段落内の改行は <br> にする", () => {
    expect(convert("一行目\n二行目").html).toBe('<p name="u1" id="u1">一行目<br>二行目</p>');
  });

  it("見出しは # と ## を h2、### を h3、#### 以下を太字の段落にする", () => {
    expect(convert("# A\n\n## B\n\n### C\n\n#### D").html).toBe(
      '<h2 name="u1" id="u1">A</h2><h2 name="u2" id="u2">B</h2><h3 name="u3" id="u3">C</h3><p name="u4" id="u4"><strong>D</strong></p>',
    );
  });

  it("箇条書き・番号付きリスト・入れ子を変換する", () => {
    expect(convert("- a\n- b\n  - c").html).toBe(
      '<ul name="u1" id="u1"><li name="u2" id="u2">a</li><li name="u3" id="u3">b<ul name="u4" id="u4"><li name="u5" id="u5">c</li></ul></li></ul>',
    );
    expect(convert("3. x\n4. y").html).toBe(
      '<ol name="u1" id="u1" start="3"><li name="u2" id="u2">x</li><li name="u3" id="u3">y</li></ol>',
    );
  });

  it("引用・コードブロック・区切り線を変換する", () => {
    expect(convert("> 引用\n> 続き").html).toBe(
      '<blockquote name="u1" id="u1"><p name="u2" id="u2">引用<br>続き</p></blockquote>',
    );
    expect(convert("```ts\nif (a < b && c) {}\n```").html).toBe(
      '<pre name="u1" id="u1"><code>if (a &lt; b &amp;&amp; c) {}</code></pre>',
    );
    expect(convert("a\n\n---\n\nb").html).toBe('<p name="u1" id="u1">a</p><hr><p name="u2" id="u2">b</p>');
  });

  it("本文の HTML 特殊文字をエスケープする", () => {
    expect(convert("<script>alert(1)</script> & x").html).not.toContain("<script>");
    expect(convert("a & b < c").html).toBe('<p name="u1" id="u1">a &amp; b &lt; c</p>');
  });

  it("斜体・取り消し線・インラインコードは装飾を外して文字を残す", () => {
    expect(convert("*斜体* ~~消し~~ `a<b`").html).toBe('<p name="u1" id="u1">斜体 消し a&lt;b</p>');
  });

  it("http(s) / mailto 以外のリンクは文字だけにして警告する", () => {
    const r = convert("[x](javascript:alert(1))");
    expect(r.html).toBe('<p name="u1" id="u1">x</p>');
    expect(r.warnings[0]).toContain("javascript:");
  });

  it("画像はアップロード後の URL で figure にし、段落の途中なら段落を分ける", () => {
    const urls = new Map([["images/a.png", "https://assets.st-note.com/a.png"]]);
    const r = convert("前 ![図 1](images/a.png) 後", urls);
    expect(r.html).toBe(
      '<p name="u1" id="u1">前</p>' +
        '<figure name="u2" id="u2"><img src="https://assets.st-note.com/a.png" alt="" width="620" height="auto"><figcaption>図 1</figcaption></figure>' +
        '<p name="u3" id="u3">後</p>',
    );
  });

  it("アップロード前（dry_run）の画像は src にローカルパスを残す", () => {
    expect(convert("![](img/b.png)").html).toContain('src="img/b.png"');
  });

  it("外部 URL の画像はリンクにして警告する", () => {
    const r = convert("![外部](https://example.com/x.png)");
    expect(r.html).toBe('<p name="u1" id="u1"><a href="https://example.com/x.png">外部</a></p>');
    expect(r.warnings[0]).toContain("外部 URL");
  });

  it("表は箇条書きに変換して警告する", () => {
    const r = convert("| 項目 | 値 |\n|---|---|\n| A | 1 |\n| B | **2** |");
    expect(r.html).toBe(
      '<ul name="u1" id="u1"><li name="u2" id="u2">項目: A / 値: 1</li><li name="u3" id="u3">項目: B / 値: <strong>2</strong></li></ul>',
    );
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("表");
  });

  it("生の HTML は削除して警告し、HTML コメントは黙って削除する", () => {
    const r = convert("<div>x</div>\n\n<!-- memo -->\n\n本文");
    expect(r.html).toBe('<p name="u1" id="u1">本文</p>');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("<div>");
  });

  it("文字数はタグを除いた文字で数える", () => {
    expect(convert("**太字**と[リンク](https://e.com)").textLength).toBe("太字とリンク".length);
  });

  it("CRLF の改行も扱える", () => {
    expect(convert("a\r\nb\r\n\r\nc").html).toBe('<p name="u1" id="u1">a<br>b</p><p name="u2" id="u2">c</p>');
  });
});

describe("collectImages", () => {
  it("画像を重複なく出現順に返す（リストや引用の中も含む）", () => {
    expect(collectImages("![a](1.png)\n\n> ![b](2.png)\n\n- ![c](1.png)")).toEqual([
      { src: "1.png", alt: "a" },
      { src: "2.png", alt: "b" },
    ]);
  });
});
