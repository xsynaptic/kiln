export interface LineScrubber {
  feed: (chunk: string) => string;
  flush: () => string;
}

// Buffered by line, because a secret split across two chunks would slip past a replace on each chunk
export function lineScrubber(secrets: Array<string>): LineScrubber {
  const live = secrets.filter((secret) => secret.length > 0);
  let buffer = "";
  return {
    feed(chunk: string): string {
      buffer += chunk;
      const cut = buffer.lastIndexOf("\n");
      if (cut === -1) {
        return "";
      }
      const complete = buffer.slice(0, cut + 1);
      buffer = buffer.slice(cut + 1);
      return scrubSecrets(complete, live);
    },
    flush(): string {
      const rest = buffer;
      buffer = "";
      return scrubSecrets(rest, live);
    },
  };
}

export function scrubSecrets(text: string, secrets: Array<string>): string {
  let out = "";
  let kept = 0;
  for (const [start, end] of coveredSpans(text, secrets)) {
    out += `${text.slice(kept, start)}[redacted]`;
    kept = end;
  }
  return out + text.slice(kept);
}

// Every match is redacted in one pass, so a secret that overlaps or contains another never leaves part of either behind
function coveredSpans(text: string, secrets: Array<string>): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      spans.push([at, at + secret.length]);
    }
  }
  const merged: Array<[number, number]> = [];
  const ordered = spans.toSorted((left, right) => left[0] - right[0]);
  for (const [start, end] of ordered) {
    const last = merged.at(-1);
    if (last !== undefined && start < last[1]) {
      last[1] = Math.max(last[1], end);
      continue;
    }
    merged.push([start, end]);
  }
  return merged;
}
