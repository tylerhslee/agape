// The one place the frontend calls the studio's agentic seam. Today it reaches the
// Claude-backed agent server (studio/agent-server) over the Vite proxy; when the
// Agape + MCP backend lands it answers the same call. See STUDIO.md §2.

export async function agentRespond(item, thread, intent = "respond") {
  const res = await fetch("/agent/respond", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      item: {
        title: item.title,
        destination: item.destination,
        status: item.status,
        mode: item.mode,
        assignee: item.assignee,
      },
      thread,
      intent,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `agent server: HTTP ${res.status}`);
  }
  return (await res.json()).text;
}
