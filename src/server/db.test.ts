import { describe, expect, it } from "vitest";
import { getDb } from "./db";

describe("getDb", () => {
  it("throws when TURSO_DATABASE_URL is not set", () => {
    delete process.env.TURSO_DATABASE_URL;
    expect(() => getDb()).toThrow("TURSO_DATABASE_URL is not set");
  });
});
