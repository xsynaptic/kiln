import type { DispatchBead } from "../queue/bd-client.ts";
import type { KnownSlug } from "../run/signals.ts";

export interface PriorLaunch {
  launch: number;
  stopReason: string | undefined;
}

export function composeBrief(
  bead: DispatchBead,
  branch: string,
  knownSlugs: Array<KnownSlug>,
  prior?: PriorLaunch,
): string {
  const lines = [
    `# Task brief: ${bead.title}`,
    "",
    `Work bead ${bead.id} on branch \`${branch}\`. Dispatch claimed it for you; read it with`,
    `\`bd show ${bead.id}\` and follow its dependencies as far as you need.`,
  ];
  if (prior !== undefined) {
    lines.push(
      "",
      `This is launch ${String(prior.launch)} of this bead. The previous run ended ${prior.stopReason ?? "without leaving a receipt"}; read this bead's comments for its handoff before starting.`,
    );
  }
  lines.push(...slugBlockLines(knownSlugs));
  return lines.join("\n");
}

export function slugBlockLines(knownSlugs: Array<KnownSlug>): Array<string> {
  if (knownSlugs.length === 0) {
    return [];
  }
  return [
    "",
    "## Signal slugs already on file",
    "",
    "Most-sighted first, each with the gist of its first sighting.",
    "",
    ...knownSlugs.map(({ gist, slug }) => `- \`${slug}\`: ${gist}`),
  ];
}

export function modelFromLabels(
  labels: Array<string> | undefined,
  allowed: readonly [string, ...Array<string>],
): string {
  const label = labels?.find((entry) => entry.startsWith("model:"));
  if (label === undefined) {
    return allowed[0];
  }
  const model = label.slice("model:".length);
  if (!allowed.includes(model)) {
    console.log(`ignoring ${label}: dispatch allows ${allowed.join(", ")}, so the run takes ${allowed[0]}`);
    return allowed[0];
  }
  return model;
}

export function slugForBead(bead: DispatchBead): string {
  const kebab = bead.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  const cut = kebab.length <= 32 ? kebab : kebab.slice(0, 32).replace(/-[^-]*$/, "");
  const slug = cut.replaceAll(/^-+|-+$/g, "");
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : bead.id;
}
