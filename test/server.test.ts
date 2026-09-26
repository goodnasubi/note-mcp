import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerDeps } from "../src/server.js";
import { clientWith, draftList } from "./helpers.js";

async function connect(deps: ServerDeps = {}) {
  const server = createServer(deps);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function text(result: unknown): string {
  const content = (result as CallToolResult).content[0];
  return content && content.type === "text" ? content.text : "";
}

const savedCookie = process.env.NOTE_SESSION_COOKIE;
afterEach(() => {
  if (savedCookie === undefined) delete process.env.NOTE_SESSION_COOKIE;
  else process.env.NOTE_SESSION_COOKIE = savedCookie;
});

describe("MCP server", () => {
  it("下書き用のツールだけを公開する", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_draft",
      "list_drafts",
      "set_eyecatch",
      "update_draft",
      "upload_image",
    ]);
  });

  it("dry_run は Cookie なしでも動き、note に何も送らない", async () => {
    delete process.env.NOTE_SESSION_COOKIE;
    const client = await connect({
      createClient: () => {
        throw new Error("dry_run でクライアントを作ってはいけない");
      },
    });
    const result = await client.callTool({
      name: "create_draft",
      arguments: { title: "T", markdown: "本文 **太字**", dry_run: true },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(text(result)) as Record<string, unknown>;
    expect(body).toMatchObject({ dry_run: true, title: "T", image_count: 0 });
    expect(body.html_preview).toContain("<strong>太字</strong>");
  });

  it("Cookie 未設定なら分かりやすいエラーを返す", async () => {
    delete process.env.NOTE_SESSION_COOKIE;
    const client = await connect();
    const result = await client.callTool({ name: "create_draft", arguments: { title: "T", markdown: "本文" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("NOTE_SESSION_COOKIE");
  });

  it("list_drafts はクライアントの結果を返す", async () => {
    const { client: noteClient } = clientWith([draftList([{ id: 1, key: "n1", name: "A" }])]);
    const client = await connect({ createClient: () => noteClient });
    const result = await client.callTool({ name: "list_drafts", arguments: {} });
    expect(JSON.parse(text(result))).toMatchObject({ drafts: [{ id: "1", title: "A" }] });
  });

  it("update_draft は数字以外の ID を受け付けない", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "update_draft",
      arguments: { id: "abc", title: "T", markdown: "x" },
    });
    expect(result.isError).toBe(true);
  });
});
