import { NoteClient } from "../src/note-client.js";

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: RequestInit["body"];
}

type Responder = (call: RecordedCall) => Response;

/**
 * 順番どおりに応答を返すモックの fetch。
 * 想定外のリクエスト（応答を用意していない呼び出し）は例外にする。
 */
export function mockFetch(responders: Responder[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responders];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: RecordedCall = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {})),
      body: init.body,
    };
    calls.push(call);
    const next = queue.shift();
    if (!next) throw new Error(`想定外のリクエスト: ${call.method} ${call.url}`);
    return next(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, remaining: () => queue.length };
}

export const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const status = (code: number, body = "") => () => new Response(body || null, { status: code });

export function clientWith(responders: Responder[]) {
  const m = mockFetch(responders);
  const client = new NoteClient({ cookieHeader: "_note_session_v5=SECRET", xsrfToken: "XSRF" }, { fetch: m.fetch });
  return { client, ...m };
}

export const currentUser = json({ data: { id: 42, urlname: "me" } });
export const presigned = json({
  data: {
    url: "https://assets.st-note.com/img/uploaded.png",
    action: "https://s3.example.com/bucket",
    post: { key: "img/uploaded.png", policy: "P", "x-amz-signature": "S" },
  },
});
export const s3Ok = status(204);

export function draftList(notes: Array<{ id: number; key: string; name: string; status?: string }>, isLastPage = true) {
  return json({ data: { notes: notes.map((n) => ({ status: "draft", ...n })), isLastPage } });
}
