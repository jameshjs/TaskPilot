# Claude Code Prompt: GitHub Issue Workflow for TaskPilot Guide

You are working on the TaskPilot repository.

First, revert the repository to this exact commit:

    4db61b31cf18e0f41afa2707d9c1a154883ae7d7

Before reverting:

1. Run git status --short.
2. Create a backup branch containing the current state:

       git branch backup/pre-github-guide-workflow

3. Reset the working tree to the target commit:

       git reset --hard 4db61b31cf18e0f41afa2707d9c1a154883ae7d7

4. Do not delete unrelated untracked user files unless they are generated build artifacts.
5. Verify that the repository is now based on the target commit.

After the reset, implement only the first GitHub workflow use case.

## Scope

Focus exclusively on the Guide section of TaskPilot.

The first external action should be:

> While guiding the user through a task plan, allow the user to create a GitHub issue from the current guide step and page context.

Do not implement:

- Discord integration.
- GitHub pull requests.
- General-purpose multi-provider reconciliation.
- Broad action workflows.
- Automatic issue creation.
- Any action outside the Guide section.

## Desired user flow

1. The user starts a TaskPilot task.
2. The user clicks **Guide Me on This Page**.
3. TaskPilot uses the current incomplete plan step.
4. TaskPilot guides the user through that step using the existing Navigator behavior.
5. If the current page or step suggests a bug, missing feature, or follow-up engineering task, show a contextual action:

   **Create GitHub Issue**

6. Clicking that action opens a reviewable issue preview containing:

   - repository;
   - issue title;
   - issue body;
   - labels, if available;
   - source page title and URL;
   - current TaskPilot goal;
   - current plan step;
   - relevant user-approved page context.

7. The user must review and explicitly approve the issue.
8. Only after approval should TaskPilot create the GitHub issue through the existing or newly added Composio integration.
9. Show the created issue URL after success.
10. The user can return to guiding the next plan step.

## Guide sequencing requirements

Fix the Guide flow while implementing this feature:

- Each click on **Guide Me on This Page** must use the current incomplete plan step.
- After a successful guide action, mark that step complete.
- Advance to the next incomplete step.
- Never repeat the same completed step.
- Do not advance when Navigator returns none, wait, scroll, low confidence, or an error.
- If all steps are complete, show a clear completion state.
- Prevent duplicate guide requests while one is running.
- Persist step completion using the existing session storage/update logic.
- Broadcast state updates so the side panel refreshes immediately.

## GitHub issue behavior

Implement a two-phase flow.

### Preview phase

Create a preview from the Guide section. The preview may be local or stored through the existing backend state mechanism.

The preview must include:

    {
      repository: string;
      title: string;
      body: string;
      labels: string[];
      sourceUrl: string;
      sourceTitle: string;
      task: string;
      currentStep: string;
    }

Do not guess the repository. If the repository is missing or ambiguous, ask the user to provide it.

Do not include sensitive information, passwords, payment details, tokens, or private form values.

### Approval phase

The user must explicitly click an approval button such as:

**Create GitHub Issue**

The issue must not be created merely because the guide action completed.

After approval:

- Execute GitHub issue creation through Composio on the backend.
- Keep the Composio API key and provider credentials on the backend only.
- Return the created issue URL and provider response.
- Display a success state in the Guide UI.
- Record a history event.

If Composio is not configured, provide a clearly labelled demo/offline fallback that does not contact GitHub.

## Architecture requirements

Inspect the repository after reverting and reuse its existing patterns.

Before editing, locate:

- the Guide button and handler;
- Navigator logic;
- active-session and plan-step mutation logic;
- background RPC routing;
- shared API/RPC types;
- Cloudflare Worker routes;
- Composio integration code, if present;
- the Guide UI component.

Prefer small, focused changes.

Use the existing architecture:

- Chrome extension UI for the Guide experience;
- background service worker for browser/session operations;
- Cloudflare Worker for GitHub/Composio execution;
- shared TypeScript types for extension/backend contracts;
- Durable Object state only if needed for the issue preview.

Add clear boundaries between:

1. Extracting Guide context.
2. Generating an issue preview.
3. Approving the preview.
4. Executing the GitHub issue creation.

## Safety requirements

Preserve all existing TaskPilot safety rules:

- Never submit arbitrary web forms.
- Never enter passwords or payment information.
- Never send external actions without explicit approval.
- Never create an issue with an unknown repository.
- Never silently include sensitive page content.
- Never expose Composio credentials to the extension.
- Never mark a Guide step complete if the navigation action failed.

## Tests

Add or update tests for:

- Guide click uses the first incomplete step.
- The next click uses the next step.
- Completed steps are not repeated.
- Failed Navigator results do not advance the plan.
- All completed steps produce a completed state.
- Issue preview includes the current task, step, page title, and URL.
- Missing repository blocks issue preview creation.
- GitHub issue creation cannot execute without approval.
- Demo/offline mode does not contact GitHub.
- Successful execution returns an issue URL and records history.
- Duplicate clicks do not create duplicate Guide completions or issues.

Run:

    npm run typecheck
    npm test
    npm run build

At the end, report:

1. The exact commit restored.
2. The root cause of the repeated Guide step.
3. Files changed.
4. How sequential Guide progression works now.
5. How GitHub issue preview and approval work.
6. How to test the workflow locally.
7. Any Composio configuration still required.
