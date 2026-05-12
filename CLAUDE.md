# analyst-agent — Campaign Manager Agent (CMA)

Mastra-based agent backend for the Campaign Management Platform. Expanding from POC (CSV analysis + E2B code execution) to the full CMA: seven Mastra Workflows orchestrating Analysis, Planning, and Activation agents.

## GitHub
`gabbylevac-gti/analyst-agent`

## Current State
- Basic analyst agent: data dictionary drafting, Python analysis code generation, E2B execution, belief extraction
- Compound learning loop: approved beliefs and code templates persist to Supabase across sessions
- Knowledge graph: `.md` files in `knowledge/` + Supabase for dynamic beliefs

## Target State
Seven Mastra Workflows each as a deterministic TypeScript step graph. Specialist Mastra Agents called from within workflow steps — never orchestrating, only contributing expertise.

**Workflows:** `/onboard`, `/design`, `/plan`, `/prep`, `/launch`, `/learn`, `/notebook`

**Agents:**
- Conversation layer: `conversation`
- Analysis: `meta-analysis`, `financial-transaction`, `in-venue`, `online-activity`, `trending-in-the-news`, `studies-surveys`
- Planning: `campaign-creation`
- Activation: `device-management`, `content-delivery`, `staff-communication`

See `../app-v2/docs/Agent-Architecture.md` for the full agent roster, step patterns, and bundle configuration.

## Stack
- TypeScript + Node.js
- Mastra framework (agents, tools, workflows)
- Claude Sonnet as primary model
- E2B (Python sandbox for code execution, one sandbox per org)
- Supabase (shared DB with app-v2)

## Current Folder Structure
```
src/
  agents/             ← Mastra Agent definitions
  tools/
    executeCode.ts    ← E2B execution; returns {html, data, summary}
    readKnowledge.ts  ← reads .md files + beliefs table
    writeBelief.ts    ← appends approved belief to knowledge graph
    saveCodeTemplate.ts ← saves approved Python template to DB + disk
    getSessionContext.ts ← returns data dictionary + CSV schema
  mastra/             ← Mastra instance config
  embedded-knowledge.ts ← static knowledge injected into agent context
  index.ts            ← entry point
agents/
  analyst/
    instructions.md   ← agent identity, role, behavioral rules
    skills/           ← draft-data-dictionary, write-analysis-code, interpret-artifact, etc.
knowledge/
  domain/             ← radar-sensors, path-classification, retail-context
  beliefs/
    approved-takeaways.md  ← seed file + append target
  output-contract.md  ← output envelope schema all templates must follow
code-templates/
  INDEX.md            ← template registry
  *.py                ← approved Python templates
jupyter-notebooks/    ← Jupyter Notebooks for developing code templates before promotion
  README.md
  shared/             ← db.py, output_contract.py helpers
  template-dev/       ← per-integration development notebooks
```

## Target Folder Structure (building toward)
```
src/
  mastra/index.ts        ← registers all agents, workflows, cron scheduler
  workflows/             ← onboard.ts, design.ts, plan.ts, prep.ts, launch.ts, learn.ts, notebook.ts
  agents/
    conversation.ts
    analysis/            ← meta-analysis.ts, financial-transaction.ts, in-venue.ts, etc.
    planning/            ← campaign-creation.ts
    activation/          ← device-management.ts, content-delivery.ts, staff-communication.ts
  tools/
    executeCode.ts       ← E2B execution
    queryKnowledge.ts    ← progressive disclosure from knowledge/INDEX.md
    queryDb.ts           ← reads Postgres structured tables
    writeDraft.ts        ← writes typed artifact as status: draft
    commitApproval.ts    ← updates artifact status to approved/rejected/altered
    logAudit.ts          ← writes to audit_log
agents/                  ← instructions.md per agent (narrative system prompts)
knowledge/               ← .md files: brand-identity, retail-operations, data-sources, technology, tactics
```

## Persistence Model
- **Postgres (structured):** campaigns, campaign_designs, knowledge_beliefs, take_aways, analysis_artifacts, hypotheses, experiments, beliefs, belief_relationships, kpi_targets, code_templates, notebooks, notebook_steps, audit_log
- **.md (knowledge graph):** domain knowledge, brand identity, integration quirks — derivative of Postgres, optimized for agent context reading
- **Rule:** Postgres is source of truth. Write to Postgres first, write to .md after approval.

### Take-Away and Belief model (POC)
A **Take-Away** is the evidence package supporting a belief: `{ belief_id FK, artifact_id FK, insights[], actions[] }`. A **Belief** (`knowledge_beliefs.content`) is the durable claim. Approving a Take-Away confirms both records. Multiple Take-Aways across sessions can corroborate the same belief, increasing its confidence.

POC uses `knowledge_beliefs` (analyst agent table). Full-vision uses `beliefs` (richer, with experiment chains). These will converge post-POC.

## Rules
- Tools are single-responsibility — one tool, one job
- The agent shares the Supabase DB with app-v2 — coordinate schema changes via new migration files only, never edit existing ones
- E2B sandbox is per org — never share sandboxes or templates across clients
- All consequential agent actions require an approval gate — `context.suspend()` / `workflow.resume()`
- Run `bun run build` to verify TypeScript before committing

## Key Docs (read before building)
All product docs live in `../app-v2/docs/`:
- Platform PRD: `../app-v2/docs/Campaign-Management-Platform-PRD.md`
- Agent architecture: `../app-v2/docs/architecture/Agent-Architecture.md`
- Data architecture: `../app-v2/docs/architecture/Data-Architecture.md`
- Risk register: `../app-v2/docs/planning/Risk-Register.md`
- QA playbook: `../app-v2/docs/qa/QA-Playbook.md`
