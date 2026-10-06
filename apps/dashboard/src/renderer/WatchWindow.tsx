// The Watch window: the live view on its own, for a second screen or a corner of this one. It follows
// the theme and govd's connection like the Dashboard, and changes nothing.
import { useEffect, useState } from "react";
import type { Status } from "../shared/contract.ts";
import { api, START_GOVD } from "./api.ts";
import { useTheme } from "./theme.ts";
import { Empty } from "./ui.tsx";
import { Watch } from "./views/Watch.tsx";

export function WatchWindow() {
  useTheme();
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => { document.title = "GovernCode · Watch"; void api().status().then(setStatus); return api().onStatus(setStatus); }, []);
  if (status?.state !== "up") return (
    <div className="watch-down">{status === null || status.state === "connecting" ? <Empty title="Connecting to govd…" />
      : <Empty title="govd is not running"><p>Start it, and Watch picks up where it is.</p><pre className="code cmd">{START_GOVD}</pre></Empty>}</div>
  );
  // A new connection (govd restarted) starts the view afresh.
  return <Watch key={status.hello.version + status.socketPath} popout />;
}
