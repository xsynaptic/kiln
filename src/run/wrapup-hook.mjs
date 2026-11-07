// Copied into the guest as is, so it can only import node's built-in modules
// Every failure exits 0 with no output, because a hook error in an unattended run is worse than a missed nudge

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";

const softMinutes = 75;
const softTokens = 400_000;
const headBytes = 64 * 1024;
const tailBytes = 512 * 1024;

try {
  main();
} catch {}

function count(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function elapsedMinutes(transcriptPath) {
  for (const line of readSlice(transcriptPath, "head").split("\n")) {
    const started = Date.parse(parseLine(line)?.timestamp ?? "");
    if (!Number.isNaN(started)) {
      const minutes = (Date.now() - started) / 60_000;
      return minutes >= 0 ? minutes : undefined;
    }
  }
  return;
}

function lastTokens(transcriptPath) {
  const lines = readSlice(transcriptPath, "tail").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseLine(lines[index]);
    if (entry?.type !== "assistant" || entry.isSidechain === true) {
      continue;
    }
    const usage = entry.message?.usage;
    if (usage === null || typeof usage !== "object") {
      continue;
    }
    const tokens =
      count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
    if (tokens > 0) {
      return tokens;
    }
  }
  return;
}

function latchPath(transcriptPath) {
  return `${transcriptPath}.wrapup-nudged`;
}

function main() {
  const transcriptPath = nudgeableTranscript(readPayload());
  if (transcriptPath === undefined) {
    return;
  }
  const tokens = lastTokens(transcriptPath);
  const minutes = elapsedMinutes(transcriptPath);
  const isOverTokens = tokens !== undefined && tokens >= softTokens;
  const isOverTime = minutes !== undefined && minutes >= softMinutes;
  if (!isOverTokens && !isOverTime) {
    return;
  }
  writeFileSync(latchPath(transcriptPath), "");
  nudge(reading(tokens, minutes));
  const markerPath = process.argv[2];
  if (markerPath !== undefined) {
    writeFileSync(markerPath, JSON.stringify(marker(tokens, minutes, isOverTokens, isOverTime)));
  }
}

function marker(tokens, minutes, isOverTokens, isOverTime) {
  return {
    minutes: minutes === undefined ? undefined : Math.round(minutes),
    tokens,
    trigger: trigger(isOverTokens, isOverTime),
  };
}

function nudge(where) {
  const message = `Budget notice from the harness, authoritative: ${where}. Stop starting new work. You have two acceptable endings and finishing is only one of them: deliver the work if it is deliverable in the room that is left, or hand it off so another agent finishes it. Handing off means committing what is green, getting the branch off this machine, and writing on your bead what is done and what remains. Your operating manual says what each of those requires. Begin nothing you cannot finish.`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        additionalContext: message,
        hookEventName: "PostToolUse",
      },
    }),
  );
}

function nudgeableTranscript(payload) {
  // The hook also fires inside subagents, and a nudged subagent would hand off work that isn't its own
  if (payload === undefined || typeof payload.agent_type === "string") {
    return;
  }
  const transcriptPath = payload.transcript_path;
  if (typeof transcriptPath !== "string" || !existsSync(transcriptPath)) {
    return;
  }
  if (existsSync(latchPath(transcriptPath))) {
    return;
  }
  return transcriptPath;
}

function parseLine(line) {
  if (typeof line !== "string" || !line.startsWith("{")) {
    return;
  }
  try {
    return JSON.parse(line);
  } catch {
    return;
  }
}

function reading(tokens, minutes) {
  const parts = [];
  if (tokens !== undefined) {
    parts.push(`~${String(Math.round(tokens / 1000))}k tokens of context`);
  }
  if (minutes !== undefined) {
    parts.push(`${String(Math.round(minutes))} minutes elapsed`);
  }
  return `this run is at ${parts.join(" and ")}`;
}

function trigger(isOverTokens, isOverTime) {
  if (isOverTokens && isOverTime) {
    return "both";
  }
  return isOverTokens ? "tokens" : "time";
}

function readPayload() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
}

function readSlice(file, end) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, end === "head" ? headBytes : tailBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, end === "head" ? 0 : size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
