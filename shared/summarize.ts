// shared/summarize.ts
// Optional auto-summary of what a peer is working on, via gpt-5.4-nano.
// If OPENAI_API_KEY is unset, returns empty string (non-fatal).

export interface SummaryInput {
  cwd: string;
  git_root: string | null;
  git_branch: string | null;
  recent_files: string[];
}

export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "branch", "--show-current"], {
      cwd, stdout: "pipe", stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? text.trim() || null : null;
  } catch {
    return null;
  }
}

export async function getRecentFiles(cwd: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(
      ["git", "log", "--name-only", "--pretty=format:", "-n", "10"],
      { cwd, stdout: "pipe", stderr: "ignore" }
    );
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return [];
    const uniq = new Set(text.split("\n").map((s) => s.trim()).filter(Boolean));
    return Array.from(uniq).slice(0, 20);
  } catch {
    return [];
  }
}

export async function generateSummary(input: SummaryInput): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return "";

  const prompt = `Summarize in one sentence what a developer is probably working on, based on this context.
CWD: ${input.cwd}
Git root: ${input.git_root ?? "(none)"}
Branch: ${input.git_branch ?? "(none)"}
Recent files: ${input.recent_files.join(", ") || "(none)"}
Return only the summary sentence, no preamble.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 60,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content?.trim() ?? "";
  } catch {
    return "";
  }
}
