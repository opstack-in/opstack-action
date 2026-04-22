// OpStack GitHub Action — src/index.js
// Submits a Terraform plan to OpStack, polls for completion,
// posts a branded PR comment, and fails the pipeline if findings
// meet or exceed the configured threshold.

const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

// ── Severity ordering ─────────────────────────────────────────────────────────
const SEVERITY_ORDER = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const SEVERITY_EMOJI = {
    CRITICAL: '🔴',
    HIGH: '🟠',
    MEDIUM: '🟡',
    LOW: '🟢',
};

// ── Sleep helper ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Fetch with API key ────────────────────────────────────────────────────────
async function opsFetch(url, options = {}) {
    const { default: fetch } = await import('node-fetch');
    const apiKey = core.getInput('api-key', { required: true });
    const headers = {
        'X-Api-Key': apiKey,
        ...options.headers,
    };
    const response = await fetch(url, { ...options, headers });
    return response;
}

// ── Submit plan to OpStack ────────────────────────────────────────────────────
async function submitAnalysis(planFile, environmentId, baseUrl, context) {
    core.info(`Submitting plan to OpStack environment ${environmentId}...`);

    const planPath = path.resolve(process.env.GITHUB_WORKSPACE || '.', planFile);
    if (!fs.existsSync(planPath)) {
        throw new Error(`Plan file not found: ${planPath}`);
    }

    const form = new FormData();
    form.append('file', fs.createReadStream(planPath), {
        filename: path.basename(planPath),
        contentType: 'application/json',
    });

    // Pass branch, commit SHA and repo info
    if (context.ref) {
        const branch = context.ref.replace('refs/heads/', '');
        form.append('branch', branch);
    }
    if (context.sha) {
        form.append('commit_sha', context.sha.substring(0, 8));
    }
    if (context.repo) {
        const repoFullName = `${context.repo.owner}/${context.repo.repo}`;
        form.append('repo_full_name', repoFullName);
    }

    const url = `${baseUrl}/api/v1/analyses?environment_id=${environmentId}`;
    const response = await opsFetch(url, {
        method: 'POST',
        body: form,
        headers: form.getHeaders(),
    });

    if (response.status === 429) {
        const data = await response.json();
        const detail = data.detail || {};
        throw new Error(
            `Analysis limit reached. ${detail.message || ''}\n` +
            `Upgrade at: ${detail.upgrade_url || baseUrl + '/account'}`
        );
    }

    if (response.status === 422) {
        const data = await response.json();
        const detail = data.detail || {};
        throw new Error(`Plan validation failed: ${detail.message || 'Unknown error'}`);
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpStack API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    core.info(`Analysis started — ID: ${data.analysis_id}`);
    return data;
}

// ── Poll for completion ───────────────────────────────────────────────────────
async function pollAnalysis(analysisId, baseUrl, pollInterval, timeoutSeconds) {
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    core.info(`Polling for analysis ${analysisId} completion...`);

    while (true) {
        if (Date.now() - startTime > timeoutMs) {
            throw new Error(
                `Analysis timed out after ${timeoutSeconds}s. ` +
                `View in OpStack: ${baseUrl}/analyses/${analysisId}`
            );
        }

        const response = await opsFetch(`${baseUrl}/api/v1/analyses/${analysisId}`);
        if (!response.ok) {
            throw new Error(`Failed to poll analysis: ${response.status}`);
        }

        const data = await response.json();
        core.debug(`Analysis status: ${data.status}`);

        if (data.status === 'COMPLETED') {
            core.info('Analysis completed.');
            return data;
        }

        if (data.status === 'FAILED') {
            throw new Error(`Analysis failed: ${data.error || 'Unknown error'}`);
        }

        await sleep(pollInterval * 1000);
    }
}

// ── Build PR comment ──────────────────────────────────────────────────────────
function buildComment(analysis, failOn, passed, blockingCount) {
    const summary = analysis.risk_summary || {};
    const critical = summary.critical || 0;
    const high = summary.high || 0;
    const medium = summary.medium || 0;
    const low = summary.low || 0;
    const total = critical + high + medium + low;

    const analysisUrl = analysis.analysis_url || '';

    // Header
    const statusIcon = passed ? '✅' : '❌';
    const statusText = passed
        ? 'No blocking findings — safe to deploy'
        : `${blockingCount} blocking finding${blockingCount !== 1 ? 's' : ''} found`;

    let comment = `## ${statusIcon} OpStack Blast Radius Analysis\n\n`;

    // Status line
    comment += `**${statusText}**`;
    if (!passed) {
        comment += ` _(threshold: ${failOn})_`;
    }
    comment += `\n\n`;

    // Live connection warning
    if (analysis.live_connection_disabled) {
        comment += `> ⚠️ **Live connection disabled** — findings are based on plan structure only and may not reflect actual infrastructure.\n\n`;
    }

    // Ghost resources warning
    if (analysis.ghost_resources && analysis.ghost_resources.length > 0) {
        comment += `> ⚠️ **${analysis.ghost_resources.length} resource(s) not found in connected environment** — these changes may fail on apply.\n\n`;
    }

    // Findings table
    comment += `### Risk Summary\n\n`;
    comment += `| Severity | Count |\n`;
    comment += `|----------|-------|\n`;
    comment += `| ${SEVERITY_EMOJI.CRITICAL} Critical | **${critical}** |\n`;
    comment += `| ${SEVERITY_EMOJI.HIGH} High     | **${high}** |\n`;
    comment += `| ${SEVERITY_EMOJI.MEDIUM} Medium   | **${medium}** |\n`;
    comment += `| ${SEVERITY_EMOJI.LOW} Low      | **${low}** |\n`;
    comment += `\n`;

    // Blocking findings detail
    const findings = analysis.findings || [];
    const threshold_idx = SEVERITY_ORDER.indexOf(failOn);
    const blocking = findings.filter(f =>
        SEVERITY_ORDER.indexOf(f.severity || 'LOW') >= threshold_idx
    );

    if (blocking.length > 0) {
        comment += `### Blocking Findings\n\n`;
        comment += `| Severity | Rule | Resource |\n`;
        comment += `|----------|------|----------|\n`;
        const shown = blocking.slice(0, 10);
        for (const f of shown) {
            const emoji = SEVERITY_EMOJI[f.severity] || '⚪';
            comment += `| ${emoji} ${f.severity} | ${f.rule_name || f.rule_id || '—'} | \`${f.resource || '—'}\` |\n`;
        }
        if (blocking.length > 10) {
            comment += `\n_...and ${blocking.length - 10} more. View full analysis for details._\n`;
        }
        comment += `\n`;
    } else if (total === 0) {
        comment += `_No risk findings detected against the connected environment._\n\n`;
    }

    // Footer
    comment += `---\n`;
    comment += `<sub>`;
    if (analysisUrl) {
        comment += `[View full analysis in OpStack](${analysisUrl}) · `;
    }
    comment += `Powered by [OpStack](https://www.opstack.in) — Know your blast radius before you deploy`;
    comment += `</sub>\n`;
    comment += `\n<!-- opstack-analysis-comment -->`;

    return comment;
}

// ── Post or update PR comment ─────────────────────────────────────────────────
async function upsertPRComment(octokit, context, body) {
    const { owner, repo } = context.repo;
    const pullNumber = context.payload.pull_request?.number;

    if (!pullNumber) {
        core.info('Not a pull request — skipping PR comment.');
        return;
    }

    // Find existing OpStack comment to update
    const { data: comments } = await octokit.rest.issues.listComments({
        owner, repo, issue_number: pullNumber,
    });

    const existing = comments.find(c =>
        c.body && c.body.includes('<!-- opstack-analysis-comment -->')
    );

    if (existing) {
        await octokit.rest.issues.updateComment({
            owner, repo, comment_id: existing.id, body,
        });
        core.info('Updated existing OpStack PR comment.');
    } else {
        await octokit.rest.issues.createComment({
            owner, repo, issue_number: pullNumber, body,
        });
        core.info('Posted OpStack PR comment.');
    }
}

// ── Set commit status ─────────────────────────────────────────────────────────
async function setCommitStatus(octokit, context, passed, analysisUrl) {
    const { owner, repo } = context.repo;
    const sha = context.sha;

    if (!sha) {
        core.info('No commit SHA — skipping status check.');
        return;
    }

    await octokit.rest.repos.createCommitStatus({
        owner,
        repo,
        sha,
        state: passed ? 'success' : 'failure',
        target_url: analysisUrl || '',
        description: passed
            ? 'OpStack: No blocking findings'
            : 'OpStack: Blocking findings detected',
        context: 'OpStack Blast Radius Analysis',
    });

    core.info(`Commit status set to: ${passed ? 'success' : 'failure'}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
    try {
        const apiKey = core.getInput('api-key', { required: true });
        const environmentId = core.getInput('environment-id', { required: true });
        const planFile = core.getInput('plan-file', { required: true });
        const failOn = core.getInput('fail-on').toUpperCase();
        const baseUrl = core.getInput('opstack-url').replace(/\/$/, '');
        const pollInterval = parseInt(core.getInput('poll-interval'), 10) || 5;
        const timeout = parseInt(core.getInput('timeout'), 10) || 300;

        // Validate fail-on
        if (!SEVERITY_ORDER.includes(failOn)) {
            throw new Error(`Invalid fail-on value: ${failOn}. Must be one of: ${SEVERITY_ORDER.join(', ')}`);
        }

        const context = github.context;
        const token = process.env.GITHUB_TOKEN;
        const octokit = token ? github.getOctokit(token) : null;

        // 1. Submit plan
        const submitted = await submitAnalysis(planFile, environmentId, baseUrl, context);

        // 2. Poll for completion
        const analysis = await pollAnalysis(
            submitted.analysis_id, baseUrl, pollInterval, timeout
        );

        // 3. Determine pass/fail
        const summary = analysis.risk_summary || {};
        const findings = analysis.findings || [];
        const thresholdIdx = SEVERITY_ORDER.indexOf(failOn);

        const blocking = failOn === 'NONE' ? [] : findings.filter(f =>
            SEVERITY_ORDER.indexOf(f.severity || 'LOW') >= thresholdIdx
        );
        const passed = blocking.length === 0;

        // 4. Set outputs
        core.setOutput('analysis-id', String(analysis.analysis_id));
        core.setOutput('analysis-url', analysis.analysis_url || '');
        core.setOutput('passed', String(passed));
        core.setOutput('critical-count', String(summary.critical || 0));
        core.setOutput('high-count', String(summary.high || 0));
        core.setOutput('medium-count', String(summary.medium || 0));
        core.setOutput('low-count', String(summary.low || 0));

        // 5. Post PR comment
        if (octokit) {
            const commentBody = buildComment(analysis, failOn, passed, blocking.length);
            await upsertPRComment(octokit, context, commentBody);
            await setCommitStatus(octokit, context, passed, analysis.analysis_url);
        } else {
            core.warning('GITHUB_TOKEN not set — skipping PR comment and status check.');
        }

        // 6. Log summary
        core.info('─────────────────────────────────');
        core.info(`OpStack Analysis: ${passed ? 'PASSED ✅' : 'FAILED ❌'}`);
        core.info(`Critical: ${summary.critical || 0}  High: ${summary.high || 0}  Medium: ${summary.medium || 0}  Low: ${summary.low || 0}`);
        if (analysis.analysis_url) {
            core.info(`Full analysis: ${analysis.analysis_url}`);
        }
        core.info('─────────────────────────────────');

        // 7. Fail the step if needed
        if (!passed) {
            core.setFailed(
                `OpStack found ${blocking.length} blocking finding(s) at or above ${failOn} severity. ` +
                `View full analysis: ${analysis.analysis_url || baseUrl}`
            );
        }

    } catch (error) {
        core.setFailed(error.message);
    }
}

run();