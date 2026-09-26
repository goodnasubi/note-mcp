import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { InputError } from "./errors.js";
import { collectImages, isRemoteUrl, markdownToNoteHtml } from "./markdown.js";
import { IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, NoteClient, type ImageFile } from "./note-client.js";

export interface ArticleInput {
  title?: string | undefined;
  markdown?: string | undefined;
  /** Markdown ファイルのパス。markdown と同時には指定できない。 */
  markdownPath?: string | undefined;
  /** 画像の相対パスの基準。省略時は markdownPath のあるディレクトリ、それもなければカレントディレクトリ。 */
  baseDir?: string | undefined;
  /** 見出し画像のパス（baseDir 基準）。 */
  eyecatchPath?: string | undefined;
}

interface LocalImage {
  /** Markdown に書かれたままのパス。 */
  src: string;
  absPath: string;
  bytes: number;
}

export interface PreparedArticle {
  title: string;
  markdown: string;
  localImages: LocalImage[];
  eyecatch?: LocalImage;
  warnings: string[];
}

export interface DryRunReport {
  dry_run: true;
  title: string;
  html_preview: string;
  html_length: number;
  text_length: number;
  image_count: number;
  images: Array<{ src: string; path: string; bytes: number }>;
  eyecatch: string | null;
  warnings: string[];
  note: string;
}

export interface SaveReport {
  id: string;
  key: string;
  edit_url: string;
  title: string;
  image_count: number;
  eyecatch_url: string | null;
  warnings: string[];
  note: string;
}

const HTML_PREVIEW_LENGTH = 500;
const MANUAL_PUBLISH_NOTE =
  "下書きとして保存しました（公開はしていません）。edit_url を開いて内容を確認し、公開は note の画面から手動で行ってください。";

/** 入力を読み込み、画像ファイルの存在・形式・サイズまで検証する。ネットワークは使わない。 */
export async function prepareArticle(input: ArticleInput): Promise<PreparedArticle> {
  if (input.markdown !== undefined && input.markdownPath !== undefined) {
    throw new InputError("markdown と markdown_path は、どちらか一方だけを指定してください。");
  }
  let markdown: string;
  let baseDir = input.baseDir ? path.resolve(input.baseDir) : process.cwd();
  if (input.markdownPath !== undefined) {
    const mdPath = path.resolve(input.markdownPath);
    if (!/\.(md|markdown)$/i.test(mdPath)) {
      throw new InputError(`markdown_path には .md ファイルを指定してください: ${input.markdownPath}`);
    }
    markdown = await readFile(mdPath, "utf8").catch(() => {
      throw new InputError(`Markdown ファイルを読めません: ${mdPath}`);
    });
    if (!input.baseDir) baseDir = path.dirname(mdPath);
  } else if (input.markdown !== undefined) {
    markdown = input.markdown;
  } else {
    throw new InputError("markdown か markdown_path を指定してください。");
  }

  markdown = stripFrontMatter(markdown);
  const warnings: string[] = [];
  let title = input.title?.trim() ?? "";
  if (!title) {
    const extracted = extractLeadingH1(markdown);
    if (!extracted) {
      throw new InputError("title を指定するか、Markdown の先頭に「# タイトル」を書いてください。");
    }
    title = extracted.title;
    markdown = extracted.rest;
    warnings.push(`先頭の見出し「${title}」をタイトルにし、本文からは除きました。`);
  }

  const localImages: LocalImage[] = [];
  for (const img of collectImages(markdown)) {
    if (isRemoteUrl(img.src)) continue; // 変換時にリンクにして警告する
    localImages.push(await resolveImage(img.src, baseDir));
  }
  const prepared: PreparedArticle = { title, markdown, localImages, warnings };
  if (input.eyecatchPath) prepared.eyecatch = await resolveImage(input.eyecatchPath, baseDir);
  return prepared;
}

export function dryRun(article: PreparedArticle): DryRunReport {
  const converted = markdownToNoteHtml(article.markdown);
  return {
    dry_run: true,
    title: article.title,
    html_preview:
      converted.html.length > HTML_PREVIEW_LENGTH ? `${converted.html.slice(0, HTML_PREVIEW_LENGTH)}…` : converted.html,
    html_length: converted.html.length,
    text_length: converted.textLength,
    image_count: article.localImages.length,
    images: article.localImages.map((i) => ({ src: i.src, path: i.absPath, bytes: i.bytes })),
    eyecatch: article.eyecatch?.absPath ?? null,
    warnings: [...article.warnings, ...converted.warnings],
    note: "dry_run のため note には何も送っていません。画像の src は、実行時にアップロード後の URL に置き換わります。",
  };
}

/** 新しい下書きを作る。 */
export async function createDraft(client: NoteClient, article: PreparedArticle): Promise<SaveReport> {
  // 空の記事だけが残るのを避けるため、認証確認と画像アップロードを先に済ませる
  await client.getCurrentUser();
  const imageUrls = await uploadImages(client, article.localImages);
  const converted = markdownToNoteHtml(article.markdown, { imageUrls });

  const note = await client.createNote(article.title);
  await client.saveDraft(note.id, { title: article.title, html: converted.html, textLength: converted.textLength });
  const eyecatchUrl = article.eyecatch ? await client.uploadEyecatch(note.id, await readImage(article.eyecatch)) : null;

  return {
    id: note.id,
    key: note.key,
    edit_url: NoteClient.editUrl(note.key),
    title: article.title,
    image_count: imageUrls.size,
    eyecatch_url: eyecatchUrl,
    warnings: [...article.warnings, ...converted.warnings],
    note: MANUAL_PUBLISH_NOTE,
  };
}

/** 既存の下書きのタイトルと本文を置き換える。下書きでなければ何もしない。 */
export async function updateDraft(client: NoteClient, id: string, article: PreparedArticle): Promise<SaveReport> {
  const existing = await client.findDraft(id);
  const imageUrls = await uploadImages(client, article.localImages);
  const converted = markdownToNoteHtml(article.markdown, { imageUrls });
  await client.saveDraft(existing.id, { title: article.title, html: converted.html, textLength: converted.textLength });
  const eyecatchUrl = article.eyecatch
    ? await client.uploadEyecatch(existing.id, await readImage(article.eyecatch))
    : null;

  return {
    id: existing.id,
    key: existing.key,
    edit_url: existing.editUrl,
    title: article.title,
    image_count: imageUrls.size,
    eyecatch_url: eyecatchUrl,
    warnings: [...article.warnings, ...converted.warnings],
    note: MANUAL_PUBLISH_NOTE,
  };
}

export async function uploadImageFile(client: NoteClient, imagePath: string): Promise<{ url: string; path: string }> {
  const img = await resolveImage(imagePath, process.cwd());
  await client.getCurrentUser();
  return { url: await client.uploadImage(await readImage(img)), path: img.absPath };
}

export async function setEyecatch(
  client: NoteClient,
  id: string,
  imagePath: string,
): Promise<{ id: string; key: string; edit_url: string; eyecatch_url: string }> {
  const img = await resolveImage(imagePath, process.cwd());
  const draft = await client.findDraft(id);
  const url = await client.uploadEyecatch(draft.id, await readImage(img));
  return { id: draft.id, key: draft.key, edit_url: draft.editUrl, eyecatch_url: url };
}

// ---- 補助 ----

async function uploadImages(client: NoteClient, images: LocalImage[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const img of images) {
    urls.set(img.src, await client.uploadImage(await readImage(img)));
  }
  return urls;
}

async function resolveImage(src: string, baseDir: string): Promise<LocalImage> {
  const decoded = safeDecodeUri(src);
  const absPath = path.resolve(baseDir, decoded);
  const ext = path.extname(absPath).toLowerCase();
  if (!IMAGE_MIME_TYPES[ext]) {
    throw new InputError(`対応していない画像形式です（PNG / JPEG / GIF のみ）: ${src}`);
  }
  const info = await stat(absPath).catch(() => {
    throw new InputError(`画像ファイルが見つかりません: ${src}（探した場所: ${absPath}）`);
  });
  if (!info.isFile()) throw new InputError(`画像のパスがファイルではありません: ${absPath}`);
  if (info.size > MAX_IMAGE_BYTES) {
    throw new InputError(`画像が大きすぎます（上限 10MB）: ${src} は ${(info.size / 1024 / 1024).toFixed(1)}MB`);
  }
  return { src, absPath, bytes: info.size };
}

async function readImage(img: LocalImage): Promise<ImageFile> {
  const ext = path.extname(img.absPath).toLowerCase();
  return {
    fileName: path.basename(img.absPath),
    mimeType: IMAGE_MIME_TYPES[ext] ?? "application/octet-stream",
    data: new Uint8Array(await readFile(img.absPath)),
  };
}

function safeDecodeUri(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

export function stripFrontMatter(markdown: string): string {
  return markdown.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

/** 先頭（空行を除く）の「# 見出し」をタイトルとして取り出す。 */
export function extractLeadingH1(markdown: string): { title: string; rest: string } | null {
  const m = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!m || !m[1]) return null;
  return { title: m[1].trim(), rest: markdown.slice(m[0].length).replace(/^\s*\n/, "") };
}
