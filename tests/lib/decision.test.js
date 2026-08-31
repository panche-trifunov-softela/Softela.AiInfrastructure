"use strict";

const { suite } = require("../harness");
const { deny, ask, pass, clamp, severity, SEVERITY } = require("../../core/lib/decision");

suite("lib/decision", ({ test, eq, deepEq }) => {
  test("deny builds a deny decision with reason and fix", () => {
    deepEq(deny("because", "do this instead"), { action: "deny", reason: "because", fix: "do this instead" });
  });

  test("deny without a fix omits the key", () => {
    const result = deny("because");
    eq(result.action, "deny");
    eq(result.reason, "because");
    eq("fix" in result, false);
  });

  test("ask builds an ask decision", () => {
    deepEq(ask("careful"), { action: "ask", reason: "careful" });
  });

  test("pass returns null", () => {
    eq(pass(), null);
  });

  test("severity ordering", () => {
    eq(severity("off"), 0);
    eq(severity("ask"), 1);
    eq(severity("deny"), 2);
  });

  test("severity of an unrecognised action is 0", () => {
    eq(severity("bogus"), 0);
  });

  test("SEVERITY exposes the raw ordering", () => {
    deepEq(SEVERITY, { off: 0, ask: 1, deny: 2 });
  });

  test("clamp keeps the less severe of the two actions", () => {
    eq(clamp("deny", "ask"), "ask");
    eq(clamp("ask", "deny"), "ask");
  });

  test("clamp is a no-op when both sides agree", () => {
    eq(clamp("deny", "deny"), "deny");
  });

  test("clamp never sharpens ask into deny", () => {
    eq(clamp("ask", "off"), "off");
  });
});
