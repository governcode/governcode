// The first message to a Controller asks, once, whether the user's own instructions come along.
// Off by default, and said plainly both ways (Dave, 2026-09-27): off is a clean start, on brings
// what the user has built up. Changeable any time in Settings › Personal instructions.
import { useState } from "react";
import { Modal } from "./ProjectDialogs.tsx";

const WHAT: Record<"claude" | "codex", { tool: string; files: string }> = {
  claude: { tool: "Claude Code", files: "your CLAUDE.md, skills, agents, commands, plugins and hooks" },
  codex: { tool: "Codex", files: "your AGENTS.md" },
};

export function PersonalDialog(props: { provider: "claude" | "codex"; home?: boolean; onChoose: (use: boolean) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const w = WHAT[props.provider];
  const choose = (use: boolean) => { setBusy(true); props.onChoose(use); };
  return (
    <Modal title={`Use your own ${w.tool} instructions?`} onClose={props.onClose}>
      <p>{w.tool} is about to work as {props.home ? "Home's" : "this project's"} Controller. You may already have set it up with {w.files}.</p>
      <div className="choice">
        <p><b>Start clean</b> (the default): {w.tool} works from its own defaults and GovernCode's instructions only.
          Nothing you set up elsewhere applies here, so it behaves the same for everyone, and none of your other workflows or
          hooks run in here.</p>
        <p><b>Use my instructions</b>: {w.tool} reads {w.files}, as it does outside GovernCode, so the habits and knowledge
          you have built up come along. Your hooks run too, inside the sandbox.</p>
      </div>
      <p className="dim small">Either way the sandbox and your Gates apply exactly the same. You can change this any time in Settings › Personal instructions.</p>
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => choose(false)}>Start clean</button>
        <button className="btn btn-accent" disabled={busy} onClick={() => choose(true)}>Use my instructions</button>
      </div>
    </Modal>
  );
}
