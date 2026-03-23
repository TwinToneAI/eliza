/**
 * Codex PR Review Pipeline
 *
 * Runs Codex review on a PR with full context from Linear,
 * then posts findings to GitHub (inline), Slack, and Linear.
 *
 * Enhanced: Fetches full file contents and repo context (AGENTS.md, README.md)
 * to give Codex architecture awareness beyond just the diff.
 */

const SLACK_CHANNEL = 'C0AMPN3KBFF'; // #agent-engineering
const MAX_CHANGED_FILES = 10;
const MAX_FILE_LINES = 500;
const MAX_PROMPT_CHARS = 200_000;

async function main() {
  const {
    GITHUB_TOKEN,
    OPENAI_API_KEY,
    SLACK_BOT_TOKEN,
    LINEAR_API_KEY,
    PR_NUMBER,
    REPO_FULL_NAME,
    PR_TITLE,
    PR_BODY,
    PR_URL,
    PR_DIFF_URL,
  } = process.env;

  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');

  const [owner, repo] = REPO_FULL_NAME.split('/');

  // 1. Extract Linear issue from PR body
  const linearIssueId = extractLinearIssue(PR_BODY || '');
  let linearContext = '';
  let linearIssueApiId = null;

  if (linearIssueId && LINEAR_API_KEY) {
    console.log(`Found Linear issue: ${linearIssueId}`);
    const issueData = await fetchLinearIssue(linearIssueId, LINEAR_API_KEY);
    if (issueData) {
      linearIssueApiId = issueData.id;
      linearContext = `
## Linear Issue Context
- **Title**: ${issueData.title}
- **Description**: ${issueData.description || 'None'}
- **Priority**: ${issueData.priority || 'None'}
- **Labels**: ${(issueData.labels?.nodes || []).map(l => l.name).join(', ') || 'None'}
- **Acceptance Criteria**: Review the code against this issue's requirements.
`;
    }
  }

  // 2. Fetch the PR diff
  console.log('Fetching PR diff...');
  const diff = await fetchDiff(owner, repo, PR_NUMBER, GITHUB_TOKEN);

  // 3. Fetch PR head SHA
  console.log('Fetching PR metadata...');
  const prHeadSha = await fetchPrHeadSha(owner, repo, PR_NUMBER, GITHUB_TOKEN);
  console.log(`PR head SHA: ${prHeadSha}`);

  // 4. Fetch full file contents for changed files
  console.log('Fetching changed file list...');
  const changedFiles = await fetchChangedFiles(owner, repo, PR_NUMBER, GITHUB_TOKEN);
  console.log(`Changed files: ${changedFiles.length} (fetching up to ${MAX_CHANGED_FILES})`);

  const fullFileContext = await fetchFullFileContents(
    owner, repo, prHeadSha, changedFiles, GITHUB_TOKEN,
  );

  // 5. Fetch repository context (AGENTS.md, README.md)
  console.log('Fetching repository context...');
  const repoContext = await fetchRepoContext(owner, repo, prHeadSha, GITHUB_TOKEN);

  // 6. Build the review prompt with token-aware truncation
  const reviewPrompt = buildReviewPrompt(
    PR_TITLE, PR_BODY, linearContext, diff, repo, fullFileContext, repoContext,
  );

  // 7. Call OpenAI API for review
  console.log(`Running Codex review (prompt: ${reviewPrompt.length} chars)...`);
  const review = await runCodexReview(reviewPrompt, OPENAI_API_KEY);
  console.log('Review complete.');

  // 8. Parse findings
  const findings = parseFindings(review);

  // 9. Post to GitHub PR as a review comment
  console.log('Posting to GitHub...');
  await postGitHubReview(owner, repo, PR_NUMBER, review, findings, GITHUB_TOKEN);

  // 10. Post summary to Slack
  if (SLACK_BOT_TOKEN) {
    console.log('Posting to Slack...');
    await postSlackSummary(PR_TITLE, PR_NUMBER, PR_URL, findings, SLACK_BOT_TOKEN);
  }

  // 11. Post to Linear issue
  if (linearIssueApiId && LINEAR_API_KEY) {
    console.log('Posting to Linear...');
    await postLinearComment(linearIssueApiId, PR_TITLE, PR_NUMBER, PR_URL, findings, review, LINEAR_API_KEY);
  }

  console.log('Done. Review posted to GitHub, Slack, and Linear.');
}

// --- Helpers ---

function extractLinearIssue(body) {
  // Match patterns like TWI2-123, ARIA-45, or Linear URLs
  const patterns = [
    /\b([A-Z]+-\d+)\b/,
    /linear\.app\/.*?\/issue\/([A-Z]+-\d+)/,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function fetchLinearIssue(identifier, apiKey) {
  const query = `
    query($identifier: String!) {
      issueSearch(filter: { identifier: { eq: $identifier } }, first: 1) {
        nodes {
          id
          title
          description
          priority
          labels { nodes { name } }
        }
      }
    }
  `;
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey,
      },
      body: JSON.stringify({ query, variables: { identifier } }),
    });
    const data = await res.json();
    return data?.data?.issueSearch?.nodes?.[0] || null;
  } catch (e) {
    console.warn(`Failed to fetch Linear issue: ${e.message}`);
    return null;
  }
}

async function fetchDiff(owner, repo, prNumber, token) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.diff',
    },
  });
  const text = await res.text();
  // Truncate if too large (keep under 100k chars for token limits)
  if (text.length > 100000) {
    return text.slice(0, 100000) + '\n\n[DIFF TRUNCATED — too large for full review]';
  }
  return text;
}

async function fetchPrHeadSha(owner, repo, prNumber, token) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch PR metadata: ${res.status}`);
  }
  const data = await res.json();
  return data.head.sha;
}

async function fetchChangedFiles(owner, repo, prNumber, token) {
  const files = [];
  let page = 1;

  // Paginate through all changed files (GitHub returns max 30 per page by default)
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
        },
      },
    );
    if (!res.ok) {
      console.warn(`Failed to fetch changed files page ${page}: ${res.status}`);
      break;
    }
    const pageFiles = await res.json();
    if (pageFiles.length === 0) break;
    files.push(...pageFiles);
    if (pageFiles.length < 100) break;
    page += 1;
  }

  return files;
}

async function fetchFullFileContents(owner, repo, headSha, changedFiles, token) {
  // Filter to files that still exist (not deleted) and limit count
  const eligibleFiles = changedFiles
    .filter(f => f.status !== 'removed')
    .slice(0, MAX_CHANGED_FILES);

  const results = await Promise.allSettled(
    eligibleFiles.map(async (file) => {
      const filePath = file.filename;
      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${headSha}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json',
            },
          },
        );
        if (!res.ok) {
          return { path: filePath, content: null, reason: `HTTP ${res.status}` };
        }
        const data = await res.json();

        // Skip binary files
        if (data.encoding !== 'base64' || !data.content) {
          return { path: filePath, content: null, reason: 'binary or empty' };
        }

        const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
        const lineCount = decoded.split('\n').length;

        if (lineCount > MAX_FILE_LINES) {
          return { path: filePath, content: null, reason: `${lineCount} lines (>${MAX_FILE_LINES} limit)` };
        }

        return { path: filePath, content: decoded, lineCount };
      } catch (e) {
        return { path: filePath, content: null, reason: e.message };
      }
    }),
  );

  const fileContents = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  // Log skipped files
  for (const f of fileContents) {
    if (f.content === null) {
      console.log(`  Skipped ${f.path}: ${f.reason}`);
    } else {
      console.log(`  Fetched ${f.path} (${f.lineCount} lines)`);
    }
  }

  return fileContents;
}

async function fetchRepoContext(owner, repo, headSha, token) {
  const contextFiles = ['AGENTS.md', 'README.md'];
  const results = {};

  await Promise.allSettled(
    contextFiles.map(async (fileName) => {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${fileName}?ref=${headSha}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json',
            },
          },
        );
        if (!res.ok) {
          console.log(`  ${fileName}: not found (${res.status})`);
          return;
        }
        const data = await res.json();
        if (data.encoding === 'base64' && data.content) {
          const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
          results[fileName] = decoded;
          console.log(`  Fetched ${fileName} (${decoded.length} chars)`);
        }
      } catch (e) {
        console.log(`  ${fileName}: fetch failed (${e.message})`);
      }
    }),
  );

  return results;
}

function buildReviewPrompt(prTitle, prBody, linearContext, diff, repoName, fullFileContext, repoContext) {
  // Priority sections (always included)
  const header = `You are a senior code reviewer for TwinTone AI.

## Pull Request
- **Title**: ${prTitle}
- **Repository**: ${repoName}
- **Description**: ${prBody || 'No description provided'}

${linearContext}

## Review Instructions
Review this pull request thoroughly. For each finding, classify it as:
- **CRITICAL**: Must fix before merge (security, cost control, breaking changes, data loss)
- **IMPORTANT**: Should fix (error handling, resource cleanup, missing validation)
- **SUGGESTION**: Nice to have (code quality, naming, test coverage)

For each finding, provide:
1. The severity (CRITICAL/IMPORTANT/SUGGESTION)
2. The file and approximate line
3. What the issue is
4. How to fix it

You have access to the full file contents (not just the diff) so you can assess:
- Whether the change is consistent with the rest of the file
- Whether existing code has similar patterns that should also be updated
- Whether imports, exports, and dependencies are correct

At the end, provide a summary verdict:
- **APPROVED**: No critical or important issues found
- **CHANGES_REQUESTED**: Critical or important issues must be addressed`;

  // Repository context section
  let repoContextSection = '';
  if (repoContext && Object.keys(repoContext).length > 0) {
    const parts = ['## Repository Context'];
    for (const [fileName, content] of Object.entries(repoContext)) {
      parts.push(`### ${fileName}\n\`\`\`markdown\n${content}\n\`\`\``);
    }
    repoContextSection = parts.join('\n\n');
  }

  // Diff section (always included)
  const diffSection = `## Code Diff\n\`\`\`diff\n${diff}\n\`\`\``;

  // Full file context section (may be truncated)
  let fileContextSection = '';
  const filesWithContent = fullFileContext.filter(f => f.content !== null);
  if (filesWithContent.length > 0) {
    const parts = ['## Full File Context\nBelow are the complete contents of changed files for full context.'];
    for (const f of filesWithContent) {
      parts.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    }
    fileContextSection = parts.join('\n\n');
  }

  // Assemble with token-aware truncation
  // Priority: header + repoContext + diff > full file context
  const prioritySections = [header, repoContextSection, diffSection].filter(Boolean).join('\n\n');
  const priorityLength = prioritySections.length;

  if (priorityLength >= MAX_PROMPT_CHARS) {
    // Even priority content exceeds limit — return without file context
    console.warn(`Priority sections already ${priorityLength} chars, skipping full file context`);
    return prioritySections.slice(0, MAX_PROMPT_CHARS);
  }

  const remainingBudget = MAX_PROMPT_CHARS - priorityLength;

  if (fileContextSection.length <= remainingBudget) {
    return [prioritySections, fileContextSection].filter(Boolean).join('\n\n');
  }

  // Truncate file context to fit within budget
  if (remainingBudget > 500) {
    const truncated = fileContextSection.slice(0, remainingBudget - 100)
      + '\n\n[FULL FILE CONTEXT TRUNCATED — exceeds token budget]';
    console.warn(`Full file context truncated from ${fileContextSection.length} to ${remainingBudget} chars`);
    return [prioritySections, truncated].join('\n\n');
  }

  // Not enough room for any file context
  console.warn('No budget remaining for full file context');
  return prioritySections;
}

async function runCodexReview(prompt, apiKey) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 16000,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${error}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

function parseFindings(review) {
  const critical = (review.match(/\bCRITICAL\b/gi) || []).length;
  const important = (review.match(/\bIMPORTANT\b/gi) || []).length;
  const suggestion = (review.match(/\bSUGGESTION\b/gi) || []).length;
  const approved = /\bAPPROVED\b/i.test(review) && !/\bCHANGES_REQUESTED\b/i.test(review);

  return { critical, important, suggestion, approved };
}

async function postGitHubReview(owner, repo, prNumber, review, findings, token) {
  const event = findings.approved ? 'APPROVE' :
                findings.critical > 0 ? 'REQUEST_CHANGES' : 'COMMENT';

  const header = findings.approved
    ? '## ✅ Codex Review — Approved\n\n'
    : `## 🔍 Codex Review — ${findings.critical} critical | ${findings.important} important | ${findings.suggestion} suggestions\n\n`;

  await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
    },
    body: JSON.stringify({
      body: header + review,
      event: event,
    }),
  });
}

async function postSlackSummary(prTitle, prNumber, prUrl, findings, slackToken) {
  const emoji = findings.approved ? '✅' : findings.critical > 0 ? '🚨' : '⚠️';
  const status = findings.approved ? 'Approved' : 'Changes Requested';

  const text = [
    `${emoji} *Codex Review — PR #${prNumber}*: ${prTitle}`,
    `*Status*: ${status}`,
    `${findings.critical > 0 ? '🚨' : '✅'} ${findings.critical} critical | ⚠️ ${findings.important} important | 💡 ${findings.suggestion} suggestions`,
    `<${prUrl}|View PR on GitHub>`,
  ].join('\n');

  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${slackToken}`,
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL,
      text: text,
      unfurl_links: false,
    }),
  });
}

async function postLinearComment(issueId, prTitle, prNumber, prUrl, findings, fullReview, apiKey) {
  const emoji = findings.approved ? '✅' : findings.critical > 0 ? '🚨' : '⚠️';
  const status = findings.approved ? 'Approved' : 'Changes Requested';

  // Truncate review for Linear (max ~4000 chars)
  const truncatedReview = fullReview.length > 3500
    ? fullReview.slice(0, 3500) + '\n\n[Review truncated — see full review on GitHub]'
    : fullReview;

  const body = [
    `${emoji} **Codex Review — PR #${prNumber}**: ${prTitle}`,
    `**Status**: ${status}`,
    `${findings.critical} critical | ${findings.important} important | ${findings.suggestion} suggestions`,
    '',
    truncatedReview,
    '',
    `[View PR on GitHub](${prUrl})`,
  ].join('\n');

  const mutation = `
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `;

  await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({
      query: mutation,
      variables: { issueId: issueId, body: body },
    }),
  });
}

main().catch(err => {
  console.error('Codex review pipeline failed:', err.message);
  process.exit(1);
});
