# Analyst Agent — Implementation Guide

A step-by-step guide to deploying the complete Analyst system: Mastra agent backend + Lovable frontend + Supabase database + E2B code execution sandbox.

**Estimated time:** 2–3 hours for a first deploy.

---

## Architecture Overview

```
Lovable (Frontend)
    │  useChat hook → streaming POST
    ▼
Mastra Platform (Agent Backend)
    │  executeCode tool → Python sandbox
    ▼
E2B Code Interpreter
    │  writeBelief / saveTemplate tools
    ▼
Supabase (Postgres + Storage)
```

Three services, zero servers to manage. All three use free tiers to start.

---

## Step 1 — Supabase Project

### 1.1 Create the project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Choose a name (e.g. `analyst-agent`) and a strong database password
3. Select the region closest to you
4. Wait ~2 minutes for provisioning

### 1.2 Run the schema

Open **SQL Editor** in the Supabase dashboard and run the following in one shot:

```sql
-- Sessions: one per chat conversation
create table sessions (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  csv_storage_path text,
  csv_public_url text,
  csv_filename text,
  objective text
);

-- Messages: chat history
create table messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  artifact_html text,
  artifact_type text,
  artifact_title text,
  created_at timestamptz default now()
);

-- Datasets: approved data dictionaries
create table datasets (
  id uuid primary key default gen_random_uuid(),
  filename text,
  column_signature text,
  schema_json jsonb,
  data_dictionary_json jsonb,
  deployment_context text,
  upload_session_id uuid references sessions(id),
  created_at timestamptz default now()
);

-- Knowledge beliefs
create table knowledge_beliefs (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  type text not null,
  confidence numeric(3,2),
  tags text[],
  evidence_session_id uuid references sessions(id),
  updated_at timestamptz,
  created_at timestamptz default now()
);

-- Code templates
create table code_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  code text not null,
  tags text[],
  parameters jsonb,
  version text,
  source_session_id uuid references sessions(id),
  approved_at timestamptz default now()
);

-- Session summaries
create table session_summaries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id),
  summary_text text not null,
  key_findings text[],
  approved_belief_ids text[],
  approved_template_ids text[],
  created_at timestamptz default now()
);
```

### 1.3 Enable Row Level Security

In SQL Editor, run:

```sql
-- Enable RLS on all tables
alter table sessions enable row level security;
alter table messages enable row level security;
alter table datasets enable row level security;
alter table knowledge_beliefs enable row level security;
alter table code_templates enable row level security;
alter table session_summaries enable row level security;

-- Allow all operations for authenticated users
create policy "Authenticated users can do everything" on sessions
  for all using (auth.role() = 'authenticated');

create policy "Authenticated users can do everything" on messages
  for all using (auth.role() = 'authenticated');

create policy "Authenticated users can do everything" on datasets
  for all using (auth.role() = 'authenticated');

create policy "Authenticated users can do everything" on knowledge_beliefs
  for all using (auth.role() = 'authenticated');

create policy "Authenticated users can do everything" on code_templates
  for all using (auth.role() = 'authenticated');

create policy "Authenticated users can do everything" on session_summaries
  for all using (auth.role() = 'authenticated');
```

### 1.4 Create the CSV storage bucket

1. Go to **Storage** → **New bucket**
2. Name it `csv-uploads`
3. Check **Public bucket** (the agent needs a public URL to download CSVs)
4. Click **Save**

### 1.5 Configure Google OAuth

1. Go to **Authentication** → **Providers** → **Google**
2. Enable Google provider
3. Copy the **Callback URL** shown — you'll need it in Google Cloud Console

**In Google Cloud Console:**
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. Go to **APIs & Services** → **OAuth consent screen**
   - User type: Internal (if using Google Workspace) or External
   - Add your domain `gtistudio.com` to authorized domains
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
   - Application type: Web application
   - Authorized redirect URIs: paste the Supabase callback URL from step 3
5. Copy the **Client ID** and **Client Secret**

**Back in Supabase:**
- Paste the Client ID and Client Secret into the Google provider settings
- Click **Save**

### 1.6 Collect your Supabase credentials

Go to **Settings** → **API** and note:
- **Project URL** (e.g. `https://xxxx.supabase.co`)
- **anon/public key** — used by Lovable frontend
- **service_role key** — used by the Mastra agent (keep this secret, never expose to browser)

---

## Step 2 — E2B Setup

E2B provides the Python sandbox where the agent executes analysis code.

1. Go to [e2b.dev](https://e2b.dev) → **Sign up** (free tier is sufficient for a POC)
2. Go to your **Dashboard** → **API Keys**
3. Click **+ New API Key** and name it `analyst-agent`
4. Copy the key — it starts with `e2b_`

That's it. E2B is serverless — no configuration needed beyond the API key.

---

## Step 3 — Mastra Platform (Agent Backend)

### 3.1 Prepare the GitHub repository

The Analyst-Agent folder needs to be a standalone Git repository for Mastra Platform to deploy it.

```bash
# Navigate to the Analyst-Agent folder
cd "Analyst-Agent"

# Initialize a git repo (if not already one)
git init
git add .
git commit -m "Initial Analyst Agent"

# Push to GitHub
# Create a new repo at github.com first, then:
git remote add origin https://github.com/YOUR_ORG/analyst-agent.git
git branch -M main
git push -u origin main
```

**Verify the package.json exists** with these dependencies before pushing:

```json
{
  "name": "analyst-agent",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "mastra dev",
    "build": "tsc"
  },
  "dependencies": {
    "@mastra/core": "latest",
    "@ai-sdk/anthropic": "latest",
    "@e2b/code-interpreter": "latest",
    "@supabase/supabase-js": "latest"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0"
  }
}
```

If `package.json` doesn't exist, create it in the `Analyst-Agent/` root before committing.

### 3.2 Connect to Mastra Platform

1. Go to [mastra.ai](https://mastra.ai) → **Sign in**
2. Click **New Project** → **Connect GitHub**
3. Authorize the GitHub app and select your `analyst-agent` repository
4. Mastra will detect the `src/index.ts` entry point automatically
5. Click **Deploy**

### 3.3 Set environment variables

In Mastra Platform → your project → **Settings** → **Environment Variables**, add:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `SUPABASE_URL` | From Supabase Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase Settings → API (secret key) |
| `E2B_API_KEY` | From E2B dashboard |
| `ALLOWED_ORIGIN` | Leave blank for now — fill in after Lovable deploy |

### 3.4 Configure CORS

After setting env vars, Mastra will redeploy. Once deployed:

1. Go to **Settings** → **CORS** (or look for it in project config)
2. Add your Lovable app URL as an allowed origin — you'll get this URL in Step 4

You can also set it via the `ALLOWED_ORIGIN` env var if Mastra uses that convention.

### 3.5 Note your Mastra API URL

After deployment, Mastra Platform assigns your project a URL like:

```
https://your-project-name.mastra.ai
```

Copy this — it becomes `VITE_MASTRA_API_URL` in Lovable.

**Verify the agent is live:**

```bash
curl -X POST https://your-project-name.mastra.ai/agents/analyst/generate \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

You should get a streaming response or JSON back from Claude.

---

## Step 4 — Lovable (Frontend)

### 4.1 Build the app

1. Go to [lovable.dev](https://lovable.dev) → **New Project**
2. Open the chat input
3. Open `LOVABLE-PROMPT.md` from this folder and paste the full contents
4. Click send and wait — Lovable will generate the full app (~3–5 minutes)

### 4.2 Connect Supabase

After generation:

1. In Lovable, click the **Supabase** icon in the sidebar (or go to **Integrations**)
2. Click **Connect Supabase**
3. Enter your Supabase project URL and anon key
4. Lovable will inject `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` automatically

### 4.3 Set the Mastra API URL

1. Go to **Settings** → **Environment Variables** in Lovable
2. Add:

| Variable | Value |
|---|---|
| `VITE_MASTRA_API_URL` | Your Mastra Platform project URL (from Step 3.5) |

### 4.4 Publish

1. Click **Publish** in Lovable
2. Lovable assigns a URL like `https://your-app.lovable.app`
3. Copy this URL

### 4.5 Update ALLOWED_ORIGIN in Mastra

Go back to Mastra Platform → **Environment Variables** and set:

```
ALLOWED_ORIGIN=https://your-app.lovable.app
```

Trigger a redeploy (or it may auto-deploy on env var change).

---

## Step 5 — Verification Checklist

Work through these in order. Each check confirms one integration point is wired correctly.

### ✅ Auth
- [ ] Open the Lovable app URL
- [ ] Click **Sign in with Google**
- [ ] Sign in with a `@gtistudio.com` account → lands in the app
- [ ] Open an incognito window, try a non-`@gtistudio.com` Google account → sees error message "Access is restricted to @gtistudio.com accounts."

### ✅ Session creation
- [ ] Click **+ New Chat**
- [ ] A new row appears in the `sessions` table in Supabase (check **Table Editor**)
- [ ] The session appears in the left sidebar

### ✅ CSV upload
- [ ] Click the paperclip icon in the input bar
- [ ] Upload a `.csv` file
- [ ] The file appears in Supabase Storage → `csv-uploads/{sessionId}/`
- [ ] A public URL is accessible in the browser (try opening it directly)
- [ ] The session row in `sessions` has `csv_public_url` populated

### ✅ Agent streaming
- [ ] After CSV upload, the agent responds (streaming text appears)
- [ ] The first response calls `getSessionContext` (you can see this in Mastra Platform logs)
- [ ] The agent drafts a data dictionary for the uploaded file

### ✅ Code execution
- [ ] Ask the agent: "Show me summary statistics for this dataset"
- [ ] The agent calls `executeCode`
- [ ] A Plotly chart or table renders inline in the chat

### ✅ Artifact persistence
- [ ] After the agent produces a chart, check the `messages` table in Supabase
- [ ] The row should have `artifact_html` populated and `artifact_type` set

### ✅ Belief extraction
- [ ] After a chart discussion, ask: "What belief should we record from this?"
- [ ] The agent proposes a belief and calls `writeBelief`
- [ ] A row appears in the `knowledge_beliefs` table

### ✅ Knowledge panel
- [ ] Click the **Knowledge** tab in the left sidebar
- [ ] The belief you just created appears under the appropriate type section

### ✅ Session summary (background)
- [ ] With an active session that has messages, click **+ New Chat**
- [ ] Wait ~10 seconds
- [ ] Check the `session_summaries` table — a summary row should appear for the closed session

---

## Troubleshooting

**CORS errors in browser console**

The Lovable app can't reach Mastra. Fix:
- Confirm `ALLOWED_ORIGIN` in Mastra Platform matches the exact Lovable URL (no trailing slash)
- Redeploy Mastra after changing env vars

**Agent returns 404**

- Confirm the agent name in `src/index.ts` is `analyst` (lowercase)
- The endpoint is `/agents/analyst/stream` — check the Lovable app is calling this path
- Check Mastra Platform deploy logs for build errors

**CSV upload works but agent can't read the file**

- Confirm the `csv-uploads` bucket is set to **Public** in Supabase Storage
- Test the public URL directly in a browser — it should return raw CSV text
- Check `executeCode` tool logs in Mastra Platform — the `csvUrl` fetch may be failing

**E2B execution errors**

- E2B sandbox is ephemeral — each `executeCode` call gets a fresh environment
- Missing Python packages: the agent must include `!pip install <package>` at the top of the script
- The `output-contract.md` requires the final `print()` to be valid JSON — malformed JSON will cause parse failures

**Supabase auth not working**

- Re-check that the Google OAuth callback URL in Google Cloud Console matches exactly what Supabase shows
- Verify the Google Cloud project has the **People API** enabled
- For `@gtistudio.com` restriction: if using a personal Google account during testing, the app will correctly reject it — use your GTI account

**Agent not loading instructions**

Mastra Platform's filesystem is read-only at runtime, but `fs.readFileSync` works on files bundled with the deployment. Verify:
- The `agents/`, `knowledge/`, and `code-templates/` directories are committed to the repo (not in `.gitignore`)
- The paths in `analystAgent.ts` are relative — `path.join("agents", "analyst", "instructions.md")` — which resolves from the process working directory at deploy time

---

## Local Development

To run the agent locally before deploying:

```bash
# Install dependencies
npm install

# Copy env vars
cp .env.example .env
# Fill in all values in .env

# Start the Mastra dev server
npx mastra dev
# → http://localhost:4111
```

The Mastra dev server exposes:
- `POST http://localhost:4111/agents/analyst/stream` — streaming chat
- `POST http://localhost:4111/agents/analyst/generate` — single-turn generate
- `GET http://localhost:4111` — Mastra Playground UI (test the agent here first)

To point the Lovable app at your local agent during development, set:
```
VITE_MASTRA_API_URL=http://localhost:4111
```

Note: Lovable runs in the browser — `localhost` will only work if Lovable is running locally too (not the hosted version). For hosted Lovable + local Mastra, use a tunnel like `ngrok`:

```bash
ngrok http 4111
# Use the https://xxxx.ngrok.io URL as VITE_MASTRA_API_URL
```

---

## What You'll See in the First Session

Once everything is wired:

1. **Upload `upload.csv`** — agent calls `getSessionContext`, drafts a data dictionary, asks about coordinate orientation
2. **"Show me summary stats"** — agent writes Python, calls E2B, renders a Plotly chart inline
3. **Discuss the chart** — agent reads `data` and `summary` fields, proposes 1-2 observations
4. **"Extract a belief from this"** — agent calls `writeBelief`, belief appears in Knowledge panel
5. **Open a new chat** — previous session is summarized in the background
6. **Upload the same file in new chat** — agent's `getSessionContext` loads the prior summary and beliefs; Python code hypothesis-tests them automatically

That last step is the system learning. The second session is measurably smarter than the first.
