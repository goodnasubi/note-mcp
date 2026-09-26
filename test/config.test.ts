import { describe, expect, it } from "vitest";
import { loadAuth } from "../src/config.js";
import { ConfigError } from "../src/errors.js";

describe("loadAuth", () => {
  it("未設定なら ConfigError", () => {
    expect(() => loadAuth({})).toThrow(ConfigError);
    expect(() => loadAuth({ NOTE_SESSION_COOKIE: "  " })).toThrow(/NOTE_SESSION_COOKIE/);
  });

  it("値だけなら _note_session_v5 の Cookie にする", () => {
    expect(loadAuth({ NOTE_SESSION_COOKIE: "abc123" })).toEqual({ cookieHeader: "_note_session_v5=abc123" });
  });

  it("Cookie ヘッダー形式なら、そのまま使い XSRF-TOKEN を取り出す", () => {
    const auth = loadAuth({ NOTE_SESSION_COOKIE: "foo=1; _note_session_v5=abc; XSRF-TOKEN=a%2Bb%3D" });
    expect(auth.cookieHeader).toBe("foo=1; _note_session_v5=abc; XSRF-TOKEN=a%2Bb%3D");
    expect(auth.xsrfToken).toBe("a+b=");
  });

  it("NOTE_XSRF_TOKEN があれば優先する", () => {
    expect(loadAuth({ NOTE_SESSION_COOKIE: "abc", NOTE_XSRF_TOKEN: "t" }).xsrfToken).toBe("t");
  });

  it("Cookie ヘッダーに _note_session_v5 がなければエラー", () => {
    expect(() => loadAuth({ NOTE_SESSION_COOKIE: "foo=1; bar=2" })).toThrow(/_note_session_v5/);
  });

  it("改行を含む値は拒否する（ヘッダーインジェクション対策）", () => {
    expect(() => loadAuth({ NOTE_SESSION_COOKIE: "abc\r\nX-Evil: 1" })).toThrow(/改行/);
  });

  it("エラーメッセージに Cookie の値を含めない", () => {
    try {
      loadAuth({ NOTE_SESSION_COOKIE: "secretvalue=1; other=2" });
    } catch (e) {
      expect(String(e)).not.toContain("secretvalue");
    }
  });
});
