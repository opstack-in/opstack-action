# OpStack Blast Radius Analysis

> Know your Terraform blast radius before the PR merges.

OpStack analyses your Terraform plan against your live AWS or Azure infrastructure and tells you exactly what will break before you apply. This GitHub Action integrates OpStack into your pull request workflow — automatically posting a findings summary and failing the pipeline if critical risks are detected.

---

## What it does

- Submits your Terraform plan to OpStack on every PR that touches `.tf` files
- Posts a findings summary as a PR comment (updates on re-run, no spam)
- Sets a commit status check (green/red) based on your configured threshold
- Fails the pipeline if findings meet or exceed the threshold
- Links directly to the full analysis in OpStack

## Example PR comment

```
✅ OpStack Blast Radius Analysis

No blocking findings — safe to deploy

### Risk Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 0 |
| 🟠 High     | 1 |
| 🟡 Medium   | 2 |
| 🟢 Low      | 0 |
```

---

## Setup

### 1. Get your OpStack API key

Go to [opstack.in](https://www.opstack.in) → Account → CI/CD API Key → Generate Key.

Add it as a GitHub repository secret named `OPSTACK_API_KEY`.

### 2. Get your Environment ID

In OpStack, open the environment you want to analyse. The ID is in the URL:
`/environments/42` → Environment ID is `42`.

Add it as a GitHub repository variable named `OPSTACK_ENVIRONMENT_ID`.

### 3. Add the workflow

Copy `.github/workflows/example.yml` from this repo into your repository and adjust:
- `working-directory` to point to your Terraform directory
- `fail-on` to your desired threshold
- Cloud credentials (Azure or AWS) as secrets

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | ✅ | — | Your OpStack API key (`opstack_token_...`) |
| `environment-id` | ✅ | — | OpStack environment ID to analyse against |
| `plan-file` | ✅ | `plan.json` | Path to the Terraform plan JSON file |
| `fail-on` | ❌ | `CRITICAL` | Minimum severity to fail the pipeline: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `NONE` |
| `opstack-url` | ❌ | `https://www.opstack.in` | OpStack base URL |
| `poll-interval` | ❌ | `5` | Seconds between status polls |
| `timeout` | ❌ | `300` | Max seconds to wait for analysis |

## Outputs

| Output | Description |
|--------|-------------|
| `analysis-id` | OpStack analysis ID |
| `analysis-url` | Direct URL to the full analysis |
| `passed` | Whether the analysis passed (`true`/`false`) |
| `critical-count` | Number of critical findings |
| `high-count` | Number of high findings |
| `medium-count` | Number of medium findings |
| `low-count` | Number of low findings |

---

## Usage example

```yaml
- name: OpStack Analysis
  uses: opstack-in/opstack-action@v1
  with:
    api-key:        ${{ secrets.OPSTACK_API_KEY }}
    environment-id: ${{ vars.OPSTACK_ENVIRONMENT_ID }}
    plan-file:      plan.json
    fail-on:        CRITICAL
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Use outputs in subsequent steps

```yaml
- name: OpStack Analysis
  id: opstack
  uses: opstack-in/opstack-action@v1
  with:
    api-key:        ${{ secrets.OPSTACK_API_KEY }}
    environment-id: ${{ vars.OPSTACK_ENVIRONMENT_ID }}
    plan-file:      plan.json
    fail-on:        NONE  # never fail, just report

- name: Print results
  run: |
    echo "Passed: ${{ steps.opstack.outputs.passed }}"
    echo "Critical: ${{ steps.opstack.outputs.critical-count }}"
    echo "Analysis: ${{ steps.opstack.outputs.analysis-url }}"
```

---

## Generate the plan

OpStack requires a Terraform plan in JSON format. Generate it like this:

```bash
terraform init
terraform plan -out=tfplan
terraform show -json tfplan > plan.json
```

---

## Permissions required

Add these permissions to your workflow job:

```yaml
permissions:
  contents: read
  pull-requests: write  # post PR comments
  statuses: write       # set commit status checks
```

---

## Connect your cloud account

New to OpStack? See the [cloud connection guide](https://www.opstack.in/docs/connect) for step-by-step instructions to connect AWS or Azure.

---

Built by [OpStack](https://www.opstack.in) — Know your blast radius before you deploy.