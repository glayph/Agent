import assert from "node:assert/strict";
import test from "node:test";
import { cookieHeaderFromNetscapeJar } from "./cookie-jar.mjs";

test("parses ordinary and HttpOnly Netscape cookies while ignoring comments", () => {
  const jar = [
    "# Netscape HTTP Cookie File",
    "#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t1792693938\tMiki_dashboard_session\tsecure-value",
    "127.0.0.1\tFALSE\t/\tFALSE\t1792693938\tother\tplain-value",
    "# a comment",
  ].join("\n");

  assert.equal(
    cookieHeaderFromNetscapeJar(jar),
    "Miki_dashboard_session=secure-value; other=plain-value",
  );
});

test("returns an empty header for malformed or comment-only jars", () => {
  assert.equal(cookieHeaderFromNetscapeJar("# comment\nnot-a-cookie"), "");
});
