import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDraft, dryRun, extractLeadingH1, prepareArticle, stripFrontMatter, updateDraft } from "../src/drafts.js";
import { InputError, NoteAuthError } from "../src/errors.js";
import { clientWith, currentUser, draftList, json, presigned, s3Ok, status } from "./helpers.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let dir: string;
let mdPath: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "note-draft-mcp-"));
  await mkdir(path.join(dir, "images"));
  await writeFile(path.join(dir, "images", "header.png"), PNG);
  await writeFile(path.join(dir, "images", "op.png"), PNG);
  mdPath = path.join(dir, "article.md");
  await writeFile(
    mdPath,
    "---\ntitle: meta\n---\n# 記事タイトル\n\n本文です。\n\n![操作](images/op.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
  );
});

describe("prepareArticle", () => {
  it("markdown_path を読み、front matter を除き、先頭の # をタイトルにする", async () => {
    const a = await prepareArticle({ markdownPath: mdPath });
    expect(a.title).toBe("記事タイトル");
    expect(a.markdown.startsWith("本文です。")).toBe(true);
    expect(a.localImages.map((i) => i.absPath)).toEqual([path.join(dir, "images", "op.png")]);
    expect(a.warnings[0]).toContain("タイトル");
  });

  it("title を指定したら先頭の # は本文に残す", async () => {
    const a = await prepareArticle({ markdownPath: mdPath, title: "別タイトル" });
    expect(a.title).toBe("別タイトル");
    expect(a.markdown.startsWith("# 記事タイトル")).toBe(true);
  });

  it("画像がなければ InputError（探した場所を示す）", async () => {
    await expect(prepareArticle({ title: "t", markdown: "![x](nope.png)", baseDir: dir })).rejects.toThrow(
      /見つかりません.*nope\.png/,
    );
  });

  it("対応していない画像形式は InputError", async () => {
    await expect(prepareArticle({ title: "t", markdown: "![x](a.svg)", baseDir: dir })).rejects.toBeInstanceOf(
      InputError,
    );
  });

  it("markdown と markdown_path の同時指定、どちらもなし、タイトルなしを拒否する", async () => {
    await expect(prepareArticle({ markdown: "a", markdownPath: mdPath })).rejects.toBeInstanceOf(InputError);
    await expect(prepareArticle({ title: "t" })).rejects.toBeInstanceOf(InputError);
    await expect(prepareArticle({ markdown: "見出しなし" })).rejects.toThrow(/title/);
  });

  it("markdown_path は .md だけ受け付ける", async () => {
    await expect(prepareArticle({ markdownPath: path.join(dir, "images", "op.png") })).rejects.toThrow(/\.md/);
  });
});

describe("dryRun", () => {
  it("note に送らず、タイトル・HTML の先頭・画像数・警告を返す", async () => {
    const a = await prepareArticle({ markdownPath: mdPath, eyecatchPath: "images/header.png" });
    const r = dryRun(a);
    expect(r).toMatchObject({ dry_run: true, title: "記事タイトル", image_count: 1 });
    expect(r.html_preview).toContain("本文です。");
    expect(r.html_preview).toContain('src="images/op.png"');
    expect(r.eyecatch).toBe(path.join(dir, "images", "header.png"));
    expect(r.warnings.some((w) => w.includes("表"))).toBe(true);
  });
});

describe("createDraft", () => {
  it("認証確認 → 画像アップロード → 記事作成 → 下書き保存 → 見出し画像 の順に呼ぶ", async () => {
    const a = await prepareArticle({ markdownPath: mdPath, eyecatchPath: "images/header.png" });
    const { client, calls, remaining } = clientWith([
      currentUser,
      presigned,
      s3Ok,
      json({ data: { id: 555, key: "nkey" } }),
      json({ data: {} }),
      json({ data: { url: "https://assets.st-note.com/eye.png" } }, 201),
    ]);
    const r = await createDraft(client, a);

    expect(calls.map((c) => `${c.method} ${c.url.host}${c.url.pathname}`)).toEqual([
      "GET note.com/api/v2/current_user",
      "POST note.com/api/v3/images/upload/presigned_post",
      "POST s3.example.com/bucket",
      "POST note.com/api/v1/text_notes",
      "POST note.com/api/v1/text_notes/draft_save",
      "POST note.com/api/v1/image_upload/note_eyecatch",
    ]);
    expect(remaining()).toBe(0);

    const saved = JSON.parse(String(calls[4]!.body)) as { name: string; body: string };
    expect(saved.name).toBe("記事タイトル");
    expect(saved.body).toContain('src="https://assets.st-note.com/img/uploaded.png"');
    expect(saved.body).not.toContain("images/op.png");

    expect(r).toMatchObject({
      id: "555",
      key: "nkey",
      edit_url: "https://editor.note.com/notes/nkey/edit/",
      image_count: 1,
      eyecatch_url: "https://assets.st-note.com/eye.png",
    });
    expect(r.note).toContain("公開はしていません");
  });

  it("Cookie 切れなら何も作らずに NoteAuthError", async () => {
    const a = await prepareArticle({ title: "t", markdown: "本文" });
    const { client, calls } = clientWith([status(401)]);
    await expect(createDraft(client, a)).rejects.toBeInstanceOf(NoteAuthError);
    expect(calls).toHaveLength(1);
  });

  it("画像アップロードに失敗したら、空の記事を作らない", async () => {
    const a = await prepareArticle({ markdownPath: mdPath });
    const { client, calls } = clientWith([currentUser, status(500)]);
    await expect(createDraft(client, a)).rejects.toThrow();
    expect(calls.some((c) => c.url.pathname === "/api/v1/text_notes")).toBe(false);
  });
});

describe("updateDraft", () => {
  it("下書きであることを確かめてから保存する", async () => {
    const a = await prepareArticle({ title: "新", markdown: "更新後" });
    const { client, calls } = clientWith([draftList([{ id: 7, key: "n7", name: "旧" }]), json({ data: {} })]);
    const r = await updateDraft(client, "7", a);
    expect(r).toMatchObject({ id: "7", key: "n7", title: "新" });
    expect(calls[1]!.url.searchParams.get("id")).toBe("7");
  });

  it("下書き一覧にない ID（公開済みなど）は保存しない", async () => {
    const a = await prepareArticle({ title: "新", markdown: "更新後" });
    const { client, calls } = clientWith([draftList([{ id: 7, key: "n7", name: "旧" }])]);
    await expect(updateDraft(client, "8", a)).rejects.toBeInstanceOf(InputError);
    expect(calls.some((c) => c.url.pathname.includes("draft_save"))).toBe(false);
  });
});

describe("helpers", () => {
  it("stripFrontMatter / extractLeadingH1", () => {
    expect(stripFrontMatter("---\na: 1\n---\nbody")).toBe("body");
    expect(stripFrontMatter("body\n---\n")).toBe("body\n---\n");
    expect(extractLeadingH1("\n# T #\n\nbody")).toEqual({ title: "T", rest: "body" });
    expect(extractLeadingH1("## T\nbody")).toBeNull();
  });
});
