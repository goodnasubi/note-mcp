import { describe, expect, it } from "vitest";
import { InputError, NoteApiError, NoteAuthError } from "../src/errors.js";
import { NoteClient } from "../src/note-client.js";
import { clientWith, currentUser, draftList, json, presigned, s3Ok, status } from "./helpers.js";

describe("NoteClient", () => {
  it("note API にはブラウザのエディタと同じヘッダーと Cookie を付ける", async () => {
    const { client, calls } = clientWith([currentUser]);
    await expect(client.getCurrentUser()).resolves.toEqual({ id: "42", urlname: "me" });
    const [call] = calls;
    expect(call!.url.toString()).toBe("https://note.com/api/v2/current_user");
    expect(call!.headers).toMatchObject({
      Cookie: "_note_session_v5=SECRET",
      "X-XSRF-TOKEN": "XSRF",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://editor.note.com",
      Referer: "https://editor.note.com/",
    });
  });

  it.each([401, 403, 302])("HTTP %i は Cookie 切れとして NoteAuthError", async (code) => {
    const { client } = clientWith([status(code)]);
    await expect(client.getCurrentUser()).rejects.toBeInstanceOf(NoteAuthError);
  });

  it("API が HTML（ログイン画面）を返したら NoteAuthError", async () => {
    const { client } = clientWith([() => new Response("<!DOCTYPE html><html>login</html>", { status: 200 })]);
    await expect(client.getCurrentUser()).rejects.toBeInstanceOf(NoteAuthError);
  });

  it("current_user の data が空なら NoteAuthError", async () => {
    const { client } = clientWith([json({ data: null })]);
    await expect(client.getCurrentUser()).rejects.toBeInstanceOf(NoteAuthError);
  });

  it("エラーメッセージに Cookie を含めない", async () => {
    const { client } = clientWith([status(500, "server error")]);
    const err = await client.getCurrentUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoteApiError);
    expect(String(err)).not.toContain("SECRET");
  });

  it("createNote → saveDraft の順に、下書き保存の API だけを呼ぶ", async () => {
    const { client, calls } = clientWith([json({ data: { id: 123, key: "nabc" } }), json({ data: {} })]);
    const note = await client.createNote("タイトル");
    await client.saveDraft(note.id, { title: "タイトル", html: "<p>x</p>", textLength: 1 });

    expect(note).toEqual({ id: "123", key: "nabc" });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /api/v1/text_notes",
      "POST /api/v1/text_notes/draft_save",
    ]);
    const save = calls[1]!;
    expect(save.url.searchParams.get("id")).toBe("123");
    expect(save.url.searchParams.get("is_temp_saved")).toBe("true");
    expect(save.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(save.body))).toEqual({
      name: "タイトル",
      body: "<p>x</p>",
      body_length: 1,
      index: false,
      is_lead_form: false,
    });
  });

  it("createNote の応答に ID がなければ NoteApiError", async () => {
    const { client } = clientWith([json({ data: {} })]);
    await expect(client.createNote("t")).rejects.toBeInstanceOf(NoteApiError);
  });

  it("数字でない ID は送らない", async () => {
    const { client, calls } = clientWith([]);
    await expect(client.saveDraft("1&publish=true", { title: "t", html: "", textLength: 0 })).rejects.toBeInstanceOf(
      InputError,
    );
    expect(calls).toHaveLength(0);
  });

  it("uploadImage は presign を取り、S3 に Cookie なしで送って URL を返す", async () => {
    const { client, calls } = clientWith([presigned, s3Ok]);
    const url = await client.uploadImage({
      fileName: "a.png",
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });
    expect(url).toBe("https://assets.st-note.com/img/uploaded.png");

    const [presign, s3] = calls;
    expect(presign!.url.toString()).toBe("https://note.com/api/v3/images/upload/presigned_post");
    expect((presign!.body as FormData).get("filename")).toBe("a.png");

    expect(s3!.url.toString()).toBe("https://s3.example.com/bucket");
    expect(s3!.headers.Cookie).toBeUndefined();
    const form = s3!.body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "x-amz-signature", "file"]);
    const file = form.get("file") as File;
    expect(file.name).toBe("a.png");
    expect(file.type).toBe("image/png");
  });

  it("S3 が失敗したら NoteApiError", async () => {
    const { client } = clientWith([presigned, status(403, "AccessDenied")]);
    await expect(
      client.uploadImage({ fileName: "a.png", mimeType: "image/png", data: new Uint8Array([1]) }),
    ).rejects.toThrow(/画像ストレージ/);
  });

  it("uploadEyecatch は note_id と画像を送る", async () => {
    const { client, calls } = clientWith([json({ data: { url: "https://assets.st-note.com/eye.png" } }, 201)]);
    const url = await client.uploadEyecatch("123", {
      fileName: "h.png",
      mimeType: "image/png",
      data: new Uint8Array([1]),
    });
    expect(url).toBe("https://assets.st-note.com/eye.png");
    expect(calls[0]!.url.pathname).toBe("/api/v1/image_upload/note_eyecatch");
    expect((calls[0]!.body as FormData).get("note_id")).toBe("123");
  });

  it("listDrafts は下書きだけを返し、編集画面の URL を付ける", async () => {
    const { client, calls } = clientWith([
      draftList([
        { id: 1, key: "n1", name: "A" },
        { id: 2, key: "n2", name: "B", status: "published" },
      ]),
    ]);
    const { drafts } = await client.listDrafts();
    expect(drafts).toEqual([
      { id: "1", key: "n1", title: "A", status: "draft", editUrl: "https://editor.note.com/notes/n1/edit/" },
    ]);
    expect(calls[0]!.url.searchParams.get("status")).toBe("draft");
  });

  it("findDraft は下書き一覧にない ID を拒否する", async () => {
    const { client } = clientWith([draftList([{ id: 1, key: "n1", name: "A" }])]);
    await expect(client.findDraft("999")).rejects.toBeInstanceOf(InputError);
  });

  it("findDraft は複数ページを探す", async () => {
    const { client, calls } = clientWith([
      draftList([{ id: 1, key: "n1", name: "A" }], false),
      draftList([{ id: 2, key: "n2", name: "B" }], true),
    ]);
    await expect(client.findDraft("2")).resolves.toMatchObject({ id: "2", key: "n2" });
    expect(calls).toHaveLength(2);
  });

  it("公開用の API を呼ぶメソッドを持たない", () => {
    const methods = Object.getOwnPropertyNames(NoteClient.prototype);
    expect(methods.filter((m) => /publish|delete|remove|price/i.test(m))).toEqual([]);
  });
});
