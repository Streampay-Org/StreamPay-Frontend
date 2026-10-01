# Security CI Setup Guide for Administrators

## Overview

This repository implements comprehensive security scanning as part of the CI/CD pipeline. This guide explains how to configure branch protection to enforce security gates.

## Workflow inventory and merge gates

The repository has six workflows. The table below describes the workflow files
as they are currently configured; it is the source of truth when deciding why
a check ran and whether a failure blocks a merge.

> **Current gating status:** every job in all six workflows sets
> `continue-on-error: true`, and most individual steps do too. Therefore all
> workflow results are **advisory today**. A repository ruleset can still list
> a check name as required, but a soft-failing job will report success even when
> one of its checks fails. Remove job/step-level `continue-on-error` from any
> check before relying on it as an enforcement gate.

| Workflow | Triggers and path filters | Jobs and purpose | Merge status | Local equivalent |
| --- | --- | --- | --- | --- |
| [CI](../.github/workflows/ci.yml) | Every push and pull request to `main`; no path filter. | `build-test`: validates the testnet-only environment, builds the Next.js app, runs Jest, then runs the API smoke suite. | **Advisory** (`continue-on-error` on the job and every step). | `npm ci`, then `STELLAR_NETWORK=testnet JWT_SECRET=streampay-dev-secret-do-not-use-in-prod NODE_ENV=test npm run build`, `npm test`, and `npm run smoke`. |
| [Clippy Lint Gate](../.github/workflows/clippy.yml) | Pushes and pull requests to `main` that change `contracts/**` or the workflow file. | `clippy` (`clippy pedantic`): compiles/lints all contract features for `wasm32v1-none`, treating warnings as errors inside the command. | **Advisory** (the job and steps soft-fail). | From `contracts/`: `cargo clippy --target wasm32v1-none --lib --all-features -- -W clippy::pedantic -D warnings`. |
| [Gas Budget Regression](../.github/workflows/gas.yml) | Pushes and pull requests to `main` that change `contracts/**` or the workflow file; also manual dispatch. | `gas-budget`: creates optimized WASM, compares the first artifact with `contracts/gas-budget.json`, and uploads the WASM and budget file. | **Advisory** (the job and steps soft-fail). | From `contracts/`: `cargo build --target wasm32v1-none --release`; compare `wc -c target/wasm32v1-none/release/*.wasm` with `baseline_wasm_bytes` and `max_regression_percent` in `gas-budget.json`. |
| [Security Scans](../.github/workflows/security.yml) | **Manual dispatch only.** It does not currently run on pushes, pull requests, or a schedule. | `codeql`: JavaScript/TypeScript SAST; `dependency-scan`: npm audit plus exemption validation; `container-scan`: Docker/Trivy when a Dockerfile exists; `security-summary`: downloads results and summarizes them. | **Advisory** (all four jobs soft-fail; the CodeQL analyze step is strict inside a soft-failing job). | Run `npm audit`; validate `.github/security-exemptions.json`; if Docker is applicable, build the image and scan it with Trivy. CodeQL requires the CodeQL CLI or a manual workflow run and has no npm script. |
| [Contract Smoke Tests](../.github/workflows/smoke.yml) | Pushes and pull requests to `main` that change `contracts/**`, `scripts/smoke*.sh`, `scripts/smoke*.ts`, or the workflow file; also manual dispatch with an optional contract id. | `contract-smoke`: installs Node/Rust/Stellar tooling, creates and funds a throwaway testnet identity, builds/deploys the contract (or reuses the supplied id), and runs the contract CLI smoke test. | **Advisory** (the job and every step soft-fail). | Install the Stellar CLI, run `npm ci`, `bash scripts/build-grantfox-contract.sh`, then `bash scripts/smoke.sh --contract` with `STELLAR_NETWORK=testnet`, `STELLAR_SEED_SECRET_KEY`, and optionally `CONTRACT_ID`. |
| [WASM Size Budget](../.github/workflows/wasm-size.yml) | Pushes and pull requests to `main` that change `contracts/**` or the workflow file. | `wasm-size-check`: builds release WASM and checks every artifact against the hard-coded 100 KiB limit. | **Advisory** (the job and steps soft-fail). | From `contracts/`: `cargo build --target wasm32v1-none --release`; verify each release `.wasm` reports no more than `102400` bytes with `wc -c`. |

### Interpreting a check result

- A workflow omitted from a pull request usually means its path filters did not
  match. Security Scans is absent unless someone starts it manually.
- A red step inside one of the current jobs is evidence that the associated
  validation failed, even when the overall job is green because it soft-fails.
- GitHub branch protection/rulesets—not the workflow file—decide which named
  checks are required. Keep the names below synchronized with the job names.
- For a genuinely blocking gate, remove `continue-on-error` at both the job and
  critical-step level, run the workflow once, and then add its check name to the
  `main` ruleset.

## Branch Protection Configuration

To enforce security gates, configure branch protection rules for `main`:

### Required Settings

1. **Navigate to:** Settings → Branches → Add rule
2. **Branch pattern:** `main`
3. **Enable the following:**

#### Protect matching branches
- ✅ **Require a pull request before merging**
  - Required approving reviews: `1` (minimum)
  - ✅ Dismiss stale pull request approvals when new commits are pushed
  - ✅ Require review from Code Owners (if applicable)

- ✅ **Require status checks to pass before merging**
  - ✅ Require branches to be up to date before merging
  
  **Recommended status checks after making those jobs strict:**
  - `build-test` (from CI workflow)
  - `CodeQL SAST` (from Security workflow)
  - `Dependency Security Audit` (from Security workflow)
  - `Container Security Scan` (optional; do not require a conditional check unless it always runs)

- ✅ **Require conversation resolution before merging**
- ✅ **Include administrators** (recommended for security compliance)

#### Additional Recommendations
- ✅ **Restrict who can push to matching branches**
  - Limit to maintainers/security team
- ✅ **Do not allow bypassing the above settings**
  - Prevents emergency bypasses that could introduce vulnerabilities

### Screenshot Guide

```
Repository Settings
  └── Branches
      └── Branch protection rules
          └── Add rule
              ├── Branch name pattern: main
              ├── ☑ Require a pull request before merging
              │   ├── Required approvals: 1
              │   ├── ☑ Dismiss stale approvals
              │   └── ☑ Require Code Owner review
              ├── ☑ Require status checks to pass
              │   ├── ☑ Require branches up to date
              │   └── Status checks:
              │       ├── build-test
              │       ├── CodeQL SAST
              │       └── Dependency Security Audit
              ├── ☑ Require conversation resolution
              └── ☑ Include administrators
```

## Exemptions Management

### Adding an Exemption

Edit `.github/security-exemptions.json`:

```json
{
  "exemptions": [
    {
      "id": "EXEMPT-001",
      "cve_id": "CVE-2024-XXXXX",
      "package": "affected-package",
      "version": "1.2.3",
      "severity": "critical",
      "reason": "Brief justification for exemption",
      "expiry_date": "2026-07-30",
      "created_by": "your-name",
      "advisory_id": "GHSA-xxxx-xxxx-xxxx",
      "mitigation": "Plan to fix or workarounds applied",
      "container_rule": null
    }
  ]
}
```

### Exemption Policy
- **Maximum duration:** 90 days
- **Auto-renewal:** Disabled (requires manual review)
- **Notification:** 14 days before expiry
- **Review required:** Yes, security team must approve

### Exemption Review Process

1. Check expiring exemptions (automated notification)
2. Verify if vulnerability has been patched upstream
3. If fixed: Remove exemption and update dependency
4. If still vulnerable: Create new exemption with fresh justification
5. Document decision in security review log

## Monitoring and Alerts

### PR Comments
The workflow automatically comments on PRs with:
- Scan status table
- Exempted vulnerabilities with advisory links
- High severity informational findings
- Action items for blocked vulnerabilities

### Slack Notifications
Configure by adding `SLACK_WEBHOOK_URL` secret:
- Triggers on security scan failures
- Includes repository, branch, commit, and run link

### Nightly Reports
- Automated GitHub issue creation on failures
- Labels: `security`, `urgent`
- Includes links to detailed run logs

## Testing the Setup

### Verify Workflow Configuration
```bash
# Test locally
npm audit

# Verify exemptions file is valid JSON
node -e "JSON.parse(require('fs').readFileSync('.github/security-exemptions.json'))"
```

### Test PR Integration
1. Create a test branch: `git checkout -b test/security-scan`
2. Make a small change
3. Push and create PR
4. Verify security checks appear in PR status checks
5. Check for security summary comment

### Simulate Vulnerability Detection
```bash
# Add a known vulnerable package (for testing only)
npm install --save-dev example-vulnerable-package

# Run audit
npm audit

# Verify workflow would block
# Then remove the test package
npm uninstall example-vulnerable-package
```

## Troubleshooting

### Workflow Not Appearing in Status Checks
- Ensure workflow has run at least once on the branch
- Check workflow file syntax with GitHub Actions linting tools
- Verify `on.pull_request.branches` includes `main`

### False Positives in CodeQL
- Review CodeQL query documentation
- Add inline comments to suppress specific warnings if appropriate
- Update CodeQL configuration in `.github/codeql-config.yml` if needed

### Dependency Audit Failing
- Run `npm audit` locally to see details
- Check if exemption exists and is valid
- Update affected packages if patches available
- Run `npm audit fix` for automatic fixes (review changes carefully)

### Container Scan Not Running
- Verify Dockerfile exists in repository root
- Check workflow conditional: `if: ${{ hashFiles('Dockerfile') != '' }}`
- Review Docker build logs for errors

## Security Notes

### SAST vs Runtime Vulnerabilities
- **SAST (CodeQL):** Scans source code for security patterns, logic flaws, injection vulnerabilities
- **Dependency Scan:** Checks third-party packages against known vulnerability databases
- **Container Scan:** Analyzes runtime image for OS-level and library vulnerabilities

**All three are complementary and necessary for fintech security compliance.**

### Fintech Compliance Considerations
- Payment stream handling requires strict security validation
- All money movement code paths must pass security gates
- No silent `continue-on-error` on critical vulnerabilities
- Exemptions require documented justification and expiry

### Out of Scope
- Runtime Application Self-Protection (RASP)
- Dynamic Application Security Testing (DAST)
- Penetration testing (should be conducted separately)
- Infrastructure security (Terraform, Kubernetes scans)

## Related Documentation
- [Security Exemptions File](../.github/security-exemptions.json)
- [Security Workflow](../.github/workflows/security.yml)
- [Contributor README](../README.md)

## Support
For security concerns or questions:
1. Review this documentation
2. Check workflow run logs for detailed error messages
3. Contact security team for exemption reviews
4. Open GitHub issue for workflow bugs
