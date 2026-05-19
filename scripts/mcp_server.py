#!/usr/bin/env python3
import json
import os
import urllib.error
import urllib.request

from mcp.server.fastmcp import FastMCP


BASE_URL = os.environ.get("AGENT_COLLAB_URL", "http://127.0.0.1:5057").rstrip("/")
mcp = FastMCP("agent-collab")


def api(path: str, method: str = "GET", body: dict | None = None):
    data = None
    headers = {"Content-Type": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(f"{BASE_URL}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            raw = res.read().decode("utf-8")
            content_type = res.headers.get("content-type", "")
            if "application/json" in content_type:
                return json.loads(raw)
            return raw
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc


@mcp.tool()
def get_state() -> str:
    """Read current collaboration state: agents, messages, tasks, decisions, and handoff."""
    return json.dumps(api("/api/state"), ensure_ascii=False, indent=2)


@mcp.tool()
def post_message(agent: str, content: str) -> str:
    """Post a message to the shared discussion stream."""
    return json.dumps(api("/api/messages", "POST", {"agent": agent, "content": content}), ensure_ascii=False, indent=2)


@mcp.tool()
def chair_directive(title: str, content: str, priority: str = "highest") -> str:
    """Record a chair directive. Chair directives are the highest-priority meeting instructions."""
    payload = {"title": title, "content": content, "priority": priority}
    return json.dumps(api("/api/chair/directives", "POST", payload), ensure_ascii=False, indent=2)


@mcp.tool()
def update_meeting(
    title: str = "",
    objective: str = "",
    phase: str = "",
    floor: str = "",
    round: int = 0,
    agent: str = "chair",
) -> str:
    """Update the current roundtable topic, objective, phase, floor, or round number."""
    payload = {"agent": agent}
    for key, value in {
        "title": title,
        "objective": objective,
        "phase": phase,
        "floor": floor,
    }.items():
        if value:
            payload[key] = value
    if round:
        payload["round"] = round
    return json.dumps(api("/api/meeting", "PATCH", payload), ensure_ascii=False, indent=2)


@mcp.tool()
def roundtable_turn(agent: str, stance: str, content: str, next_floor: str = "") -> str:
    """Submit a roundtable speech turn for Codex, Claude Code, Hermes, or the chair."""
    payload = {"agent": agent, "stance": stance, "content": content}
    if next_floor:
        payload["nextFloor"] = next_floor
    return json.dumps(api("/api/meeting/turns", "POST", payload), ensure_ascii=False, indent=2)


@mcp.tool()
def propose_motion(title: str, rationale: str, proposed_by: str) -> str:
    """Submit a proposal for the chair to accept, reject, defer, or send back for more work."""
    payload = {"title": title, "rationale": rationale, "proposedBy": proposed_by}
    return json.dumps(api("/api/motions", "POST", payload), ensure_ascii=False, indent=2)


@mcp.tool()
def create_task(
    title: str,
    description: str = "",
    owner: str = "unassigned",
    priority: str = "medium",
    created_by: str = "system",
) -> str:
    """Create a shared task for Codex, Claude Code, Hermes, or an unassigned queue."""
    payload = {
        "title": title,
        "description": description,
        "owner": owner,
        "priority": priority,
        "createdBy": created_by,
    }
    return json.dumps(api("/api/tasks", "POST", payload), ensure_ascii=False, indent=2)


@mcp.tool()
def update_task(
    task_id: str,
    owner: str = "",
    status: str = "",
    priority: str = "",
    title: str = "",
    description: str = "",
    agent: str = "system",
    note: str = "",
) -> str:
    """Update a task owner, status, priority, title, description, or add a note."""
    payload = {"agent": agent}
    for key, value in {
        "owner": owner,
        "status": status,
        "priority": priority,
        "title": title,
        "description": description,
        "note": note,
    }.items():
        if value:
            payload[key] = value
    return json.dumps(api(f"/api/tasks/{task_id}", "PATCH", payload), ensure_ascii=False, indent=2)


@mcp.tool()
def record_decision(title: str, rationale: str, agent: str = "system") -> str:
    """Record a decision and its rationale."""
    return json.dumps(api("/api/decisions", "POST", {"title": title, "rationale": rationale, "agent": agent}), ensure_ascii=False, indent=2)


@mcp.tool()
def update_handoff(current_lead: str, next_action: str, blockers: str = "", agent: str = "system") -> str:
    """Update current lead, next action, and blockers."""
    payload = {
        "currentLead": current_lead,
        "nextAction": next_action,
        "blockers": blockers,
        "agent": agent,
    }
    return json.dumps(api("/api/handoff", "PATCH", payload), ensure_ascii=False, indent=2)


@mcp.tool()
def export_handoff() -> str:
    """Export the current collaboration handoff as Markdown."""
    return api("/api/export")


if __name__ == "__main__":
    mcp.run()
