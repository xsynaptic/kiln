import { z } from "zod";

import { optionalText } from "../shared/lenient-json.ts";

export const bdIssueSchema = z.object({
  assignee: optionalText,
  id: optionalText,
  issue_type: optionalText,
  labels: z
    .unknown()
    .transform((labels) => (Array.isArray(labels) ? labels.filter((label) => typeof label === "string") : undefined))
    .optional(),
  parent: optionalText,
  started_at: optionalText,
  status: optionalText,
  title: optionalText,
});

export const bdGateSchema = z.object({
  await_id: optionalText,
  await_type: optionalText,
  id: optionalText,
  status: optionalText,
  updated_at: optionalText,
});

export const bdDependencySchema = z.object({
  await_id: optionalText,
  await_type: optionalText,
  created_at: optionalText,
  dependency_type: optionalText,
  id: optionalText,
  status: optionalText,
});

export const bdCommentSchema = z.object({
  author: z.string(),
  created_at: z.string(),
  text: z.string(),
});

export type BdIssue = z.output<typeof bdIssueSchema>;
export type BdGate = z.output<typeof bdGateSchema>;
export type BdDependency = z.output<typeof bdDependencySchema>;
