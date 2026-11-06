import { describe, expect, it } from "vitest";

import { bdCommentSchema, bdIssueSchema } from "#src/queue/bd-records.ts";
import { parseEach, parseJson } from "#src/shared/lenient-json.ts";

describe("bd records", () => {
  it("keeps object entries and drops non-objects, nested arrays and non-arrays", () => {
    const parsed = parseJson('[{"id":"bd-1"},null,3,"x",["bd-3"],{"id":"bd-2"}]');
    expect(parseEach(bdIssueSchema, parsed).map((issue) => issue.id)).toEqual(["bd-1", "bd-2"]);
    expect(parseEach(bdIssueSchema, undefined)).toEqual([]);
    expect(parseEach(bdIssueSchema, { id: "bd-1" })).toEqual([]);
  });

  it("reads a null or mistyped field as absent without dropping the record", () => {
    const [issue] = parseEach(bdIssueSchema, [{ assignee: null, id: "bd-1", labels: ["model:opus", 7], status: 3 }]);
    expect(issue).toEqual({ assignee: undefined, id: "bd-1", labels: ["model:opus"], status: undefined });
  });

  it("drops a comment missing any field it needs", () => {
    const comments = [
      { author: "dispatch", created_at: "2026-11-06T00:00:00Z", text: "dispatched to kiln-1" },
      { author: "dispatch", created_at: null, text: "no timestamp" },
    ];
    expect(parseEach(bdCommentSchema, comments).map((comment) => comment.text)).toEqual(["dispatched to kiln-1"]);
  });

  it("reads output that is not JSON as nothing", () => {
    expect(parseJson("bd: database is locked")).toBeUndefined();
    expect(parseEach(bdIssueSchema, parseJson("bd: database is locked"))).toEqual([]);
  });
});
