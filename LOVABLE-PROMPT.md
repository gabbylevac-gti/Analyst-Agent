# Lovable Build Prompt — Analyst Agent Chat App

Paste the following prompt into Lovable to generate the full application.

---

## PROMPT

Build a data analysis chat application called **Analyst Agent**. It is a tool for a small internal team at GTI Studio to upload CSV files and explore data through natural language conversation with an AI agent.

---

### Authentication

Use Supabase Google OAuth. On login, verify that the user's email ends in `@gtistudio.com`. If it does not, show an error message: "Access is restricted to @gtistudio.com accounts." and sign them out. Store the authenticated user's email and id in the session. No user-facing roles or permissions — all authenticated users see the same shared workspace.

Google OAuth is already configured in the Supabase project with a Google Cloud OAuth client. Once this app is published, the Lovable app URL must be added as an Authorized Redirect URI in Google Cloud Console for the existing OAuth client, and the Client ID and Secret must be entered in Supabase → Authentication → Providers → Google. Implement the sign-in flow using `supabase.auth.signInWithOAuth({ provider: 'google' })`.

---

### Layout

Two-panel layout:
- **Left sidebar** (260px wide, collapsible on mobile): chat history list + "New Chat" button
- **Main panel**: active chat conversation

**Left sidebar contents:**
- "Analyst" logo/wordmark at top
- "+ New Chat" button (prominent, top of list)
- List of past chat sessions, each showing: session title (first message truncated to 40 chars) + relative timestamp (e.g. "2 days ago")
- Clicking a session loads it in the main panel
- Active session is highlighted

**Main panel — empty state (no session selected):**
- Centered: "Upload a CSV to begin"
- Subtitle: "Start a new chat and upload your data file to explore it with the Analyst agent."
- "+ New Chat" button

**Main panel — active session:**
- Chat message thread (scrollable, newest at bottom)
- Input bar pinned to bottom: text input + send button + file upload button (paperclip icon)
- Session title editable by clicking it (defaults to first user message)

---

### Supabase Schema

The Supabase project is already configured — tables, RLS policies, and storage bucket are all created. Do not run any `create table` statements. Connect to the existing project using the environment variables below and use the Supabase client to read and write these tables:

**`sessions`** — one row per chat conversation
- `id` uuid PK
- `title` text
- `created_at`, `updated_at` timestamptz
- `csv_storage_path` text — path in Supabase Storage
- `csv_public_url` text — public URL for the agent to download
- `csv_filename` text
- `objective` text — user's stated goal

**`messages`** — chat history
- `id` uuid PK
- `session_id` uuid → sessions
- `role` text (`'user'` or `'assistant'`)
- `content` text
- `artifact_html` text (nullable) — rendered HTML for chart/table artifacts
- `artifact_type` text (nullable) — `'chart'` | `'table'` | `'text'` | `'multi'`
- `artifact_title` text (nullable)
- `created_at` timestamptz

**`datasets`** — approved data dictionaries
- `id` uuid PK, `filename` text, `column_signature` text, `schema_json` jsonb, `data_dictionary_json` jsonb, `deployment_context` text, `upload_session_id` uuid → sessions, `created_at` timestamptz

**`knowledge_beliefs`** — agent-written beliefs approved by user
- `id` uuid PK, `content` text, `type` text, `confidence` numeric(3,2), `tags` text[], `evidence_session_id` uuid → sessions, `updated_at` timestamptz, `created_at` timestamptz

**`code_templates`** — approved Python analysis functions
- `id` uuid PK, `name` text, `description` text, `code` text, `tags` text[], `parameters` jsonb, `version` text, `source_session_id` uuid → sessions, `approved_at` timestamptz

**`session_summaries`** — produced by the summarize-session skill
- `id` uuid PK, `session_id` uuid → sessions, `summary_text` text, `key_findings` text[], `approved_belief_ids` text[], `approved_template_ids` text[], `created_at` timestamptz

Storage bucket `csv-uploads` already exists with public read access.

---

### CSV Upload Flow

When the user clicks the file upload button (paperclip icon) or drags a file into the chat:

1. Accept `.csv` files only. Show an error for other types.
2. Upload the file to Supabase Storage bucket `csv-uploads` at path `{sessionId}/{filename}`.
3. Get the public URL from Supabase Storage.
4. Update the `sessions` row with `csv_storage_path`, `csv_public_url`, and `csv_filename`.
5. Show a user message in the chat: "📎 {filename} uploaded. What would you like to explore?"
6. Send a message to the agent API: `"User uploaded CSV: {filename}. Public URL: {csvPublicUrl}. Begin by calling getSessionContext, then draft a data dictionary for this file."`

---

### Agent API Connection

The agent runs on Mastra Platform. Its base URL is stored in the environment variable `VITE_MASTRA_API_URL`.

**Streaming chat endpoint**: `POST {VITE_MASTRA_API_URL}/api/agents/analyst/stream`

Request body:
```json
{
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "sessionId": "uuid"
}
```

Use the Vercel AI SDK `useChat` hook with `api` set to this endpoint. Pass `sessionId` as a body option. Enable streaming.

**Important**: Pass the full message history from the `messages` table for the current session on every request so the agent has full context.

---

### Message Rendering

Each message in the chat thread:

**User messages**: Right-aligned bubble, light background. Text only.

**Assistant messages**: Left-aligned, no bubble. Render as markdown (use a markdown renderer like `react-markdown`). If the message contains an `artifact_html` field, render it in an iframe or sandboxed div below the text content.

**Artifact rendering**: When the agent streams a response that contains an artifact (detected by parsing the stream for a JSON envelope with `type: chart | table | text | multi`):
- Extract the `html` field and render it in a sandboxed `<div>` using `dangerouslySetInnerHTML` or an iframe.
- Store the `artifact_html`, `artifact_type`, and `artifact_title` in the `messages` table row.
- For `multi` type, render each artifact in sequence.
- Charts render as interactive Plotly.js — they are self-contained HTML with the Plotly CDN loaded.

**Parsing the stream for artifacts**: The agent's streaming response is text. When the response is complete, check if the final assistant message contains a JSON code block or a line beginning with `{\"type\":`. If found, extract it as the artifact envelope, render `envelope.html`, and store in Supabase.

---

### New Chat Flow

1. User clicks "+ New Chat"
2. Create a new row in `sessions` table
3. Set the active session to the new session ID
4. Show an empty chat panel with input focused
5. First user message becomes the session `objective` and `title`

When a session is closed (user opens a new chat while an existing session has messages):
- POST to `{VITE_MASTRA_API_URL}/api/agents/analyst/generate` with message: `"The user is closing this session. Please call summarize-session and write a session summary to Supabase using the writeBelief tool with type: session_summary and sessionId: {sessionId}."`
- This triggers the agent to produce and save the session summary in the background.

---

### Loading States

- While streaming: show a typing indicator (animated dots) in the assistant message position
- While uploading CSV: show a progress bar below the input bar
- When loading a past session: show a skeleton loader in the message area

---

### Knowledge Panel (optional sidebar tab)

Add a second tab to the left sidebar: "Knowledge". When selected, show two sections:

**Beliefs** (from `knowledge_beliefs` table):
- List grouped by type (Belief, Take-Away, Pending)
- Each item: confidence badge + content truncated to 2 lines + tags
- Confidence color: green ≥ 0.80, yellow 0.60–0.79, gray < 0.60

**Templates** (from `code_templates` table):
- List: name + version badge + description
- Each item links to viewing the full code (modal or expand)

This panel is read-only — the agent manages writes.

---

### Environment Variables

```
VITE_MASTRA_API_URL=https://analyst-agent.server.mastra.cloud
VITE_SUPABASE_URL=https://bgmfxooysgqqqjhelhap.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_lGZG7mSMt0NbbRXhT8roOg_Nbk5X6_Q
```

---

### Design

- Clean, minimal. No decorative elements.
- Font: Inter or system-ui
- Primary color: dark slate (#1e293b)
- Accent: indigo (#6366f1)
- Background: white (#ffffff) with light gray sidebar (#f8fafc)
- Message bubbles: user = indigo-50 (#eef2ff), assistant = no bubble (text on white)
- Code blocks in markdown: monospace, light gray background
- Confidence badges: small pill shape, color-coded (green/yellow/gray)

---

### What NOT to build

- No admin panel
- No user profile settings  
- No notification system
- No real-time collaboration (no multi-user presence)
- No mobile-specific layout (responsive is fine, mobile-first is not required)
