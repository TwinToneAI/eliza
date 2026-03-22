/**
 * Codex PR Review Pipeline
 *
 * Runs Codex review on a PR with full context from Linear,
 * then posts findings to GitHub (inline), Slack, and Linear.
 */

const SLACK_CHANNEL = 'C0AMPN3KBFF'; // #agent-engineering

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

  // 3. Build the review prompt
  const reviewPrompt = buildReviewPrompt(PR_TITLE, PR_BODY, linearContext, diff, repo);

  // 4. Call OpenAI API for review
  console.log('Running Codex review...');
  const review = await runCodexReview(reviewPrompt, OPENAI_API_KEY);
  console.log('Review complete.');

  // 5. Parse findings
  const findings = parseFindings(review);

  // 6. Post to GitHub PR as a review comment
  console.log('Posting to GitHub...');
  await postGitHubReview(owner, repo, PR_NUMBER, review, findings, GITHUB_TOKEN);

  // 7. Post summary to Slack
  if (SLACK_BOT_TOKEN) {
    console.log('Posting to Slack...');
    await postSlackSummary(PR_TITLE, PR_NUMBER, PR_URL, findings, SLACK_BOT_TOKEN);
  }

  // 8. Post to Linear issue
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

function buildReviewPrompt(prTitle, prBody, linearContext, diff, repoName) {
  return `You are a senior code reviewer for TwinTone AI.

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

At the end, provide a summary verdict:
- **APPROVED**: No critical or important issues found
- **CHANGES_REQUESTED**: Critical or important issues must be addressed

## Code Diff
\`\`\`diff
${diff}
\`\`\``;
}

async function runCodexReview(prompt, apiKey) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'o4-mini',
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
