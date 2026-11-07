import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sortBy } from "remeda";

import type { RunSignal } from "./receipts.ts";

import { agentRunsPath, ensureDir } from "../shared/run-artifacts.ts";

const header = `# Signals

Friction filed by runs (their structured output, per the detached mode doc) or added by hand. A queue,
not a record: triage while operating the loop, and delete entries freely once actioned.
`;

export interface KnownSlug {
  gist: string;
  slug: string;
}

interface SlugRecency {
  count: number;
  lastSighted: string | undefined;
  slug: string;
}

interface Section {
  body: string;
  count: number;
  slug: string;
}

export function appendSignalsFile(repoRoot: string, signals: Array<RunSignal>, source: string): string {
  ensureDir(agentRunsPath(repoRoot));
  const file = agentRunsPath(repoRoot, "signals.md");
  const document = existsSync(file) ? readFileSync(file, "utf8") : header;
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(file, bumpSignals(document, signals, source, date));
  return file;
}

/** @internal */
export function bumpSignals(document: string, signals: Array<RunSignal>, source: string, date: string): string {
  let result = document;
  for (const signal of signals) {
    result = bumpOne(result, signal, source, date);
  }
  return result;
}

export function knownSlugs(repoRoot: string): Array<KnownSlug> {
  const file = agentRunsPath(repoRoot, "signals.md");
  if (!existsSync(file)) {
    return [];
  }
  return knownSlugsIn(readFileSync(file, "utf8"));
}

export function knownSlugsIn(document: string): Array<KnownSlug> {
  return byCountThenSlug(parseSections(document)).map((section) => ({
    gist: gistOf(section.body),
    slug: section.slug,
  }));
}

export function slugRecency(document: string): Array<SlugRecency> {
  return byCountThenSlug(parseSections(document)).map((section) => ({
    count: section.count,
    lastSighted: [...section.body.matchAll(/^- (\d{4}-\d{2}-\d{2}) /gm)]
      .map((match) => match[1] ?? "")
      .toSorted()
      .at(-1),
    slug: section.slug,
  }));
}

function bumpOne(document: string, signal: RunSignal, source: string, date: string): string {
  // A note comes from an agent, and a line break in it could fake another section's heading
  const sighting = `- ${date} ${source} | ${signal.note.replaceAll(/\s+/g, " ")}`;
  // Slugs are checked as kebab-case when read, so they are safe inside this regular expression
  const heading = new RegExp(String.raw`^## ${signal.slug} \(x(\d+)\)$`, "m");
  const match = heading.exec(document);
  if (match === null) {
    return `${document.replace(/\n*$/, "\n")}\n## ${signal.slug} (x1)\n\n${sighting}\n`;
  }
  const count = Number(match[1]) + 1;
  const sectionStart = match.index + match[0].length;
  const nextHeading = document.indexOf("\n## ", sectionStart);
  const sectionEnd = nextHeading === -1 ? document.length : nextHeading;
  const before = document.slice(0, match.index);
  const body = document.slice(sectionStart, sectionEnd).replace(/\s+$/, "");
  const after = document.slice(sectionEnd);
  return `${before}## ${signal.slug} (x${String(count)})${body}\n${sighting}\n${after}`;
}

function byCountThenSlug(sections: Array<Section>): Array<Section> {
  return sortBy(sections, [(section) => section.count, "desc"], (section) => section.slug);
}

function gistOf(body: string): string {
  const first = body.split("\n", 1)[0] ?? "";
  const divider = first.indexOf(" | ");
  const note = (divider === -1 ? first : first.slice(divider + 3)).trim();
  return note.length > 110 ? `${note.slice(0, 110).trimEnd()}...` : note;
}

function parseSections(document: string): Array<Section> {
  const sections: Array<Section> = [];
  let open: undefined | { count: number; slug: string; start: number };
  const close = (end: number): void => {
    if (open === undefined) return;
    sections.push({
      body: document.slice(open.start, end).trim(),
      count: open.count,
      slug: open.slug,
    });
  };
  for (const heading of document.matchAll(/^## ([a-z0-9][a-z0-9-]*) \(x(\d+)\)$/gm)) {
    close(heading.index);
    open = {
      count: Number(heading[2]),
      slug: heading[1] ?? "",
      start: heading.index + heading[0].length,
    };
  }
  close(document.length);
  return sections;
}
