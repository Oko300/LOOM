---
name: loom
description: Recall and update Loom's memory for the user's active project. Use when the user asks about their project, wants to continue working, or mentions what they're building.
---

# Loom — Project Memory Skill

Use this skill to help users access Loom's project memory and continue coding sessions with full context.

## When to activate

- User says "continue my project", "what was I working on", "pick up where I left off"
- User mentions code, their project, or asks what Loom remembers
- User wants to start a coding session
- User asks "what's my stack", "what did I decide about X", "what have I tried"

## What Loom remembers

Loom stores per-user project memory including:
- Project name and purpose
- Technology stack
- Current focus and recent activity
- Key architectural decisions
- Things that were tried and abandoned
- Where the last session ended

## How to help

1. Invoke the `get_memory` tool via Loom to retrieve the user's current project memory
2. Present it naturally — tell the user what their project is, what they were working on, where they left off
3. Ask what they want to work on next
4. Direct them to open Loom for a full session with workspace access

## Example responses

**User:** "What was I building again?"
→ Check memory and say: "You're building [project name] — [purpose]. Last time you were focused on [current_focus] and left off at [where_left_off]. Want to continue?"

**User:** "Continue my project"
→ "Opening Loom for you. You were working on [project name] — [where_left_off]. Starting a session now."

**User:** "What tech stack am I using?"
→ Pull memory and say: "Your project uses [stack list]. Want me to open Loom so you can keep building?"

**User:** "What decisions have I made so far?"
→ "Here's what Loom has recorded: [key_decisions list]. Open Loom to continue with full workspace access."
