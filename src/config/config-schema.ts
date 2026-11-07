import { z } from "zod";

// Never import the config loader here: the test descriptor imports this file, and the loader's top-level await would deadlock

const versionPin = /^\d+\.\d+\.\d+$/;

// These values are pasted into shell commands inside the VM, so each pattern allows only characters the shell reads literally
function shellWord(pattern: RegExp) {
  return z.string().regex(pattern);
}

const envKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

const guestPathSchema = shellWord(/^[\w.-]+(\/[\w.-]+)*$/);

const modelSchema = shellWord(/^[a-z0-9][a-z0-9.-]*$/i);

const dispatchSchema = z
  .object({
    models: z.tuple([modelSchema], modelSchema).default(["opus"]),
    reviewModel: modelSchema.default("opus"),
  })
  .refine((dispatch) => dispatch.models.includes(dispatch.reviewModel), {
    message: "dispatch.reviewModel must be one of dispatch.models",
    path: ["reviewModel"],
  });

const machineUserSchema = z.object({
  email: z.string().min(1),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
});

const gatesSchema = z.object({
  author: z.string().min(1),
  env: z.record(envKeySchema, shellWord(/^[\w.:/-]+$/)).default({}),
  merge: z.string().min(1),
  verdictFiles: z.record(z.string().regex(/^[\w.-]+$/), guestPathSchema).default({}),
  warmCommand: z.string().min(1).optional(),
});

const identitySchema = z
  .object({
    cloneDirName: shellWord(/^[\w.-]+$/).optional(),
    gatekeeperLogin: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    githubRepo: shellWord(/^[\w.-]+\/[\w.-]+$/),
    machineUser: machineUserSchema,
    projectName: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  })
  .transform(({ cloneDirName, githubRepo, ...identity }) => ({
    ...identity,
    cloneDirName: cloneDirName ?? githubRepo.slice(githubRepo.indexOf("/") + 1),
    githubRepo,
  }));

const pinsSchema = z.object({
  beads: z.string().regex(versionPin).optional(),
  claude: z.string().regex(versionPin).optional(),
  gitleaks: z.string().regex(versionPin).optional(),
});

const mcpServerSchema = z.object({
  args: z.array(shellWord(/^[\w@/.:{}=,^-]+$/)).default([]),
  command: shellWord(/^[\w./-]+$/),
  name: shellWord(/^[a-z0-9][a-z0-9-]*$/),
});

const guestSchema = z.object({
  globalPackages: z.array(shellWord(/^[\w@][\w@/.^~-]*$/)).default([]),
  hostLinks: z.array(shellWord(/^[\w.][\w.-]*$/)).default([]),
  mcpServers: z.array(mcpServerSchema).default([]),
  pins: pinsSchema.optional(),
  playwrightPackage: shellWord(/^[\w@.][\w@/.-]*$/).optional(),
});

const slotsSchema = z
  .object({
    // Slots add up to 8000 to each port, and the result has to stay below Linux's ephemeral port range at 32768
    devPorts: z.record(envKeySchema, z.number().int().min(1).max(24_575)).default({}),
    max: z.number().int().min(1).max(8).default(8),
    resetVolumes: z.array(shellWord(/^[a-z0-9][\w.-]*$/i)).default([]),
  })
  .refine(
    (slots) =>
      new Set(Object.values(slots.devPorts).map((port) => port % 1000)).size === Object.keys(slots.devPorts).length,
    // Slots shift ports by whole thousands, so two ports ending in the same three digits would collide in some slot
    { message: "devPorts must be distinct mod 1000", path: ["devPorts"] },
  );

// `prefault`, not `default`: zod 4's `default` skips the nested schema, so its own field defaults would never apply
export const kilnConfigSchema = z.object({
  dispatch: dispatchSchema.prefault({}),
  gates: gatesSchema,
  guest: guestSchema.prefault({}),
  identity: identitySchema,
  projectDoc: guestPathSchema,
  slots: slotsSchema.prefault({}),
});

export type KilnConfig = z.output<typeof kilnConfigSchema>;

type KilnConfigInput = z.input<typeof kilnConfigSchema>;

export function defineKilnConfig(config: KilnConfigInput) {
  return config;
}
