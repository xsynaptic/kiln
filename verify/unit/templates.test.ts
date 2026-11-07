import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const templatesDir = path.resolve(import.meta.dirname, "../../templates");

describe("templates", () => {
  it("links only files that ship beside them, since a consumer copies the folder whole", () => {
    const docs = readdirSync(templatesDir, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".md"));
    for (const doc of docs) {
      const content = readFileSync(path.join(templatesDir, doc), "utf8");
      const relative = [...content.matchAll(/\]\(([^)#]+)\)/g)]
        .map((match) => match[1] ?? "")
        .filter((target) => !/^[a-z]+:/.test(target));
      const strays = relative.filter((target) => !existsSync(path.join(templatesDir, path.dirname(doc), target)));
      expect({ doc, strays }).toEqual({ doc, strays: [] });
    }
  });
});
