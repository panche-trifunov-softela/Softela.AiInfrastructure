"use strict";

const { suite } = require("../harness");
const { isReadToolName } = require("../../core/lib/read-tools");

suite("lib/read-tools", ({ test, eq, ok }) => {
  test("isReadToolName recognises every read-shaped tool name, on either host", () => {
    for (const name of ["read", "notebookread", "read_file", "view_file", "view", "open_file", "cat_file"]) {
      ok(isReadToolName(name), `expected ${name} to be recognised`);
    }
  });

  test("isReadToolName is case-insensitive", () => {
    ok(isReadToolName("Read"));
    ok(isReadToolName("READ_FILE"));
    ok(isReadToolName("View"));
  });

  test("isReadToolName rejects a non-read tool name", () => {
    eq(isReadToolName("Write"), false);
    eq(isReadToolName("Edit"), false);
    eq(isReadToolName("Bash"), false);
    eq(isReadToolName(""), false);
    eq(isReadToolName(null), false);
    eq(isReadToolName(undefined), false);
  });
});
