# analyst-agent — Campaign Manager Agent (CMA) POC

Mastra-based agent backend. Currently a POC handling CSV analysis + code execution. Expanding to implement the full Campaign Manager Agent — orchestrating Analysis, Planning, and Activation sub-agent teams across all seven playbooks.

## GitHub
`gabbylevac-gti/analyst-agent`

## Current State
- Basic analyst agent: receives CSV, drafts data dictionary, writes Python analysis code, executes in E2B, interprets artifacts, extracts beliefs
- Compound learning loop: session summaries, approved beliefs, and code templates persist to Supabase across sessions
- Knowledge graph: .md files in `knowledge/` + Supabase for dynamic beliefs

## Target State (full CMA)
Full agent hierarchy following the `.claude/agents/` folder structure defined in `app-v2/docs/Campaign-Manager-Agent-PRD.md`:
- CMA (orchestrator) with 7 playbook commands
- Analysis Team: meta-analysis, in-venue, financial-transaction, online-activity, trending-in-the-news, studies-surveys
- Planning Team: campaign-creation
- Activation Team: device-management, content-delivery, staff-communication

## Stack
- TypeScript + Node.js
- Mastra framework (agents, tools, workflows, memory)
- Claude Sonnet as primary model
- E2B (Python sandbox for code execution, sandboxed per client)
- Supabase (shared DB with app-v2 — structured records)
- .md knowledge graph (domain expertise, beliefs, learning loops)

## Current Folder Structure
```
src/
  agents/             ← Mastra agent definitions
  tools/
    executeCode.ts    ← E2B execution; returns {html, data, summary}
    readKnowledge.ts  ← reads domain .md files + beliefs table
    writeBelief.ts    ← appends approved belief to knowledge graph
    saveCodeTemplate.ts ← saves approved Python template to DB + disk
    getSessionContext.ts ← returns data dictionary + CSV schema
  mastra/             ← Mastra config and setup
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
```

## Persistence Model
- **Postgres (structured):** campaigns, take_aways, experiments, learned_beliefs, code_templates, session_summaries, datasets (data dictionary)
- **.md (knowledge graph):** domain knowledge, approved beliefs — derivative of Postgres, optimized for agent context reading
- **Rule:** Postgres is source of truth. Write to Postgres first, write to .md after approval.

## Compound Learning Loop
1. User uploads CSV → agent drafts data dictionary → user approves → persists to Supabase
2. Agent writes Python → executes in E2B → interprets artifact
3. Approved analysis code → promoted to code template (Supabase + disk)
4. Agent extracts belief → user approves → written to knowledge graph
5. Session ends → session summary distilled → stored for next session priming
6. Session N+1 primed with: recent summaries, relevant beliefs (by tag), available templates, approved data dictionary

## Rules
- Tools are single-responsibility — one tool, one job
- Never modify `embedded-knowledge.ts` without understanding its impact on agent context
- The agent shares the Supabase DB with app-v2 — coordinate schema changes
- E2B sandbox is per client — never share sandboxes or templates across clients
- Knowledge writes require approval gates — agents surface for approval, CMA commits
- Run `bun run build` to verify TypeScript before committing

## Key Docs (read before building)
- Platform PRD: `../app-v2/docs/Campaign-Management-Platform-PRD.md`
- CMA folder structure + architecture: `../app-v2/docs/Campaign-Manager-Agent-PRD.md`
- Analyst Agent POC spec: `../app-v2/docs/Analyst-Agent-PRD.md`
