/**
 * Rich per-tool descriptions that appear in the system prompt.
 *
 * These are intentionally more detailed than the brief `description` field
 * in each tool's schema — they mirror the style of guidance that Claude Code
 * injects for every tool so the model understands when and how to use each one.
 */
export function getToolPromptDescriptions(): Record<string, string> {
  return {
    // ── File system ──────────────────────────────────────────────────────────

    Read: `Reads a file from the local filesystem.
- The file_path parameter must be an absolute path, not a relative path
- By default reads up to 2000 lines from the beginning of the file
- You can specify offset and limit for partial reads on large files
- Results are returned with line numbers in cat -n format (spaces + number + tab + content)
- Can read images (PNG, JPG), PDFs, and Jupyter notebooks (.ipynb)
- You MUST read a file before editing it — never assume its contents
- You can call multiple Read tools in the same response to read several files in parallel`,

    Write: `Writes a file to the local filesystem.
- This will overwrite the file if it already exists
- If the file already exists, you MUST use Read first to read its current contents
- ALWAYS prefer editing existing files over creating new ones with Write
- NEVER proactively create documentation files (*.md, README) unless explicitly requested
- Only use emojis in file content if the user explicitly requests them
- After writing, the file is immediately available for subsequent Read or Edit calls`,

    Edit: `Performs exact string replacements in files.
- You MUST use Read on the file at least once before calling Edit
- The edit will FAIL if old_string is not found in the file
- The edit will FAIL if old_string matches more than one location — provide more surrounding context to make it unique
- Use replace_all: true to rename a variable or string across the entire file
- Preserve the exact indentation shown in the Read output (spaces/tabs after the line-number prefix)
- Prefer Edit over Write when modifying existing files — it is safer and produces cleaner diffs
- You can issue multiple Edit calls in the same response for unrelated changes in the same file`,

    // ── Shell ────────────────────────────────────────────────────────────────

    Bash: `Executes a bash command with an optional timeout.
- Working directory persists between successive Bash calls; other shell state (environment variables, aliases) does not
- DO NOT use Bash for file operations when a dedicated tool exists:
  - Read files → use the Read tool, not cat / head / tail / sed
  - Edit files → use the Edit tool, not sed / awk
  - Create files → use the Write tool, not echo >file or cat <<EOF
  - Find files by pattern → use the Glob tool, not find or ls
  - Search file contents → use the Grep tool, not grep or rg
- Always quote file paths that contain spaces with double quotes
- Output exceeding 30 000 characters is truncated before being returned
- Use run_in_background: true for long-running commands you don't need to wait on immediately
- When multiple independent commands are needed, issue them in separate parallel Bash calls
- For sequential dependent commands, chain them with && in a single call
- Avoid interactive flags (-i) — the shell has no TTY`,

    // ── Search & discovery ───────────────────────────────────────────────────

    Glob: `Fast file pattern matching that searches across the entire project.
- Supports standard glob patterns such as "**/*.ts" or "src/**/*.{ts,tsx}"
- Returns matching file paths sorted by modification time (most-recently-changed first)
- Use this instead of Bash find or ls when you need to locate files by name
- You can call multiple Glob tools in the same response to run several patterns in parallel`,

    Grep: `Powerful content search built on ripgrep.
- Supports full regex syntax — e.g., "log.*Error", "function\\s+\\w+"
- Filter the search with the glob parameter (e.g., "*.ts") or type parameter (e.g., "ts", "py")
- Output modes:
  - "files_with_matches" (default) — returns only the file paths that matched
  - "content" — returns the matching lines with optional context (use -A, -B, -C for context lines)
  - "count" — returns match counts per file
- Use head_limit to cap the number of results
- Always prefer Grep over Bash grep or rg`,

    // ── Web ──────────────────────────────────────────────────────────────────

    WebFetch: `Fetches content from a URL and converts HTML to markdown.
- HTTP URLs are automatically upgraded to HTTPS
- The prompt parameter describes what information you want extracted from the page
- Results may be truncated for very large pages
- Includes a 15-minute cache — repeated fetches of the same URL are fast
- Will not work for authenticated or private URLs (e.g., Google Docs, internal Confluence)
- For GitHub URLs, prefer the gh CLI via Bash instead`,

    WebSearch: `Search the web for up-to-date information beyond the model's knowledge cutoff.
- Returns search result blocks including titles, snippets, and URLs
- Always include a "Sources:" section in your response when you use search results
- Use the current year in queries when searching for recent documentation or events`,

    // ── Subagents & tasks ────────────────────────────────────────────────────

    Task: `Launch a specialized subagent to handle a complex, multi-step task autonomously.
- Available subagent types: Explore (read-only research), Plan (planning without edits), code-writer, general-purpose
- Launch multiple agents concurrently when the tasks are independent
- The agent result is NOT directly visible to the user — you must summarize it in your reply
- Provide a clear, self-contained prompt so the agent can work without further clarification
- The agent runs in the same working directory by default; pass cwd to override`,

    TaskOutput: `Retrieve output from a running or completed background Bash task.
- Pass the task_id returned when the task was started with run_in_background
- Set block: true (default) to wait until the task finishes before returning
- Set a timeout (milliseconds) to cap how long you wait
- Check status: "running" | "completed" | "error"`,

    TaskStop: `Stop a running background Bash task.
- Pass the task_id returned when the task was started with run_in_background
- This sends SIGTERM to the process; output collected so far is preserved`,

    // ── Task list (project management) ───────────────────────────────────────

    TaskCreate: `Create a new task in the shared task list to track progress on complex work.
- subject: short imperative title (e.g., "Add authentication middleware")
- description: full context and acceptance criteria so any agent can pick it up
- activeForm: present-continuous label shown in the spinner while in_progress (e.g., "Adding middleware")
- New tasks start with status "pending" and no owner
- Use this proactively for multi-step work spanning 3 or more distinct steps`,

    TaskUpdate: `Update a task's status, details, owner, or dependencies.
- Status workflow: pending → in_progress → completed (use "deleted" to remove)
- Mark a task in_progress BEFORE you start working on it
- Mark a task completed only when you have FULLY finished it — not on partial progress
- Use addBlocks / addBlockedBy to wire up dependencies between tasks
- Read the latest task state with TaskGet before updating to avoid stale overwrites`,

    TaskGet: `Retrieve the full details of a task by its ID.
- Returns subject, description, status, owner, and dependency lists (blocks / blockedBy)
- Always fetch a task before starting work to confirm its blockedBy list is empty`,

    TaskList: `List all tasks in the current task list with a summary of each.
- Shows id, subject, status, owner, and which task IDs are blocking each entry
- After completing a task, call TaskList to find newly unblocked work
- Prefer working on tasks in ascending ID order when multiple tasks are available`,

    // ── Team coordination ────────────────────────────────────────────────────

    TeamCreate: `Create a new team to coordinate multiple agents working in parallel.
- Creates a team config file at ~/.open-agent/teams/{team-name}/config.json
- Creates a shared task directory at ~/.open-agent/tasks/{team-name}/
- Spawn teammates with the Task tool using the team_name parameter
- Always shut down teammates with SendMessage (shutdown_request) before calling TeamDelete`,

    TeamDelete: `Remove the team and its task directory when all work is complete.
- Will fail if the team still has active members — send shutdown_request first
- Clears team context from the current session`,

    SendMessage: `Send messages to agent teammates within a team.
- type "message": direct message to a single teammate (specify recipient by name)
- type "broadcast": send the same message to ALL teammates — use sparingly, it is expensive
- type "shutdown_request": ask a teammate to gracefully shut down
- type "shutdown_response": approve or reject a received shutdown request (pass request_id)
- type "plan_approval_response": approve or reject a teammate's plan (pass request_id)
- Always refer to teammates by NAME, never by agent ID
- Messages are automatically delivered; you do not need to check an inbox manually`,

    // ── Plan mode ────────────────────────────────────────────────────────────

    EnterPlanMode: `Enter plan mode to design an implementation approach before writing code.
- In plan mode you can read files and explore the codebase, but cannot write or edit
- Use this when the user asks you to plan or think through an approach first
- Call ExitPlanMode when your plan is ready for the user to review`,

    ExitPlanMode: `Exit plan mode and submit the plan for user approval.
- Pass allowedPrompts to pre-approve specific Bash commands that will be needed
- The user will review your plan before implementation begins`,

    // ── Notebook ─────────────────────────────────────────────────────────────

    NotebookEdit: `Edit a cell in a Jupyter notebook (.ipynb file).
- notebook_path must be an absolute path
- cell_id identifies the target cell; omit to target the first cell
- edit_mode:
  - "replace" (default) — overwrite the cell's source
  - "insert" — add a new cell after the specified cell
  - "delete" — remove the specified cell
- cell_type: "code" or "markdown"
- Returns the original and updated file contents for verification`,

    // ── Worktree ─────────────────────────────────────────────────────────────

    EnterWorktree: `Create an isolated git worktree on a new branch to work without affecting the main tree.
- Creates the worktree under .open-agent/worktrees/{name} in the current directory
- Also creates a new git branch named open-agent/{name}
- Provide name to give the worktree a meaningful label; a random suffix is used if omitted
- The repository must already be a git repo`,

    // ── MCP ──────────────────────────────────────────────────────────────────

    ListMcpResourcesTool: `List resources available from configured MCP (Model Context Protocol) servers.
- Returns uri, name, mimeType, description, and the server name for each resource
- Filter by server name to see only resources from a specific server
- Use ReadMcpResourceTool to fetch the content of a specific resource`,

    ReadMcpResourceTool: `Read a specific resource from an MCP server by server name and URI.
- Both server and uri are required
- Use ListMcpResourcesTool first to discover available resources and their URIs`,

    // ── Utility ──────────────────────────────────────────────────────────────

    AskUserQuestion: `Ask the user a clarifying question during execution.
- Use this to gather preferences, resolve ambiguous instructions, or get a decision
- Provide 2–4 concrete options so the user can answer quickly
- Users can always supply a custom answer beyond the listed options
- Do not ask unnecessary questions — only use this when you genuinely cannot proceed`,

    ToolSearch: `Search for available tools and load them for use.
- Use keyword queries to discover tools (e.g., "slack message", "notebook jupyter")
- Use "select:<tool_name>" to load a specific tool by exact name
- Both modes load the returned tools — once a tool appears in results it is ready to call
- Do NOT call a deferred tool before loading it with ToolSearch`,

    Skill: `Execute a named skill (slash command) within the current conversation.
- Skills are markdown files stored under ~/.open-agent/skills/ or <cwd>/.open-agent/skills/
- Pass the skill name without the .md extension (e.g., "commit", "review-pr")
- Pass args to supply additional context to the skill
- Use /help in the REPL to list available skills`,

    Config: `Get or set OpenAgent configuration values stored in ~/.open-agent/settings.json.
- operation "get": read the current value of a setting
- operation "set": write a new value for a setting
- Common settings: defaultModel, permissionMode, maxTurns, thinking, effort`,
  };
}
