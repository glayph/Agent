# 📄 Terms of Service & Usage Guidelines

## Overview

These Terms of Service govern the use of the glayph/agent framework. By installing, deploying, or using the software, you agree to be bound by these terms, including the acceptable use policy, warranty disclaimer, and operational guidelines set forth below.

---

## 📋 Scope & Acceptance

### Who These Terms Apply To

- **Individual users** — developers, researchers, and hobbyists
- **Commercial entities** — businesses, startups, and enterprises
- **Public organizations** — government and non-profit entities
- **Contributors** — anyone contributing code or documentation

### Acceptance

By using glayph/agent, you agree to:

1. Read and understand these Terms of Service
2. Comply with all applicable laws and regulations
3. Follow these terms when using glayph/agent
4. Respect the rights of other users and contributors
5. Assume responsibility for your use of the software

> **Note:** If you do not agree with these terms, discontinue use of glayph/agent immediately.

---

## ✅ Acceptable Use Policy

### Permitted Uses

#### 1. Development & Testing
- Personal projects and prototypes
- Academic research and teaching
- Open-source contributions
- Learning and experimentation
- Proof-of-concept applications

#### 2. Commercial Applications
- Product development using the framework
- Agent-based services for clients
- Internal business process automation
- Customer-facing agent solutions

### Prohibited Uses

#### 1. Illegal Activities
- Malware creation or distribution
- Unauthorized system access (hacking)
- Data theft or exfiltration
- Generation of violent or harmful content
- Terrorist or extremist material

#### 2. Unauthorized Access
- Bypassing security controls
- Unauthorized data manipulation or destruction
- Abuse of system resources
- Account hijacking or impersonation

#### 3. Harmful Content
- Hate speech or discriminatory content
- Harassment or targeted abuse
- Fraudulent or deceptive content
- Copyright or trademark infringement

#### 4. Unauthorized Distribution
- Reverse engineering beyond license terms
- Extraction of components without authorization
- Misuse of APIs or webhooks
- Data mining without permission

---

## ⚖️ Warranty Disclaimer

### "As Is" Provision

The glayph/agent framework is provided **"as is"** and **"as available"**, without warranty of any kind, express or implied, including but not limited to:

- **No implied warranties** of merchantability, fitness for a particular purpose, or non-infringement
- **No guarantee of accuracy** that the software will meet your requirements
- **No guarantee of security** that the software is free from vulnerabilities
- **No guarantee of availability** that the software will operate without interruption

### Limitation of Liability

To the maximum extent permitted by law:

| Item | Limitation |
|------|-----------|
| **Liability Cap** | Total liability shall not exceed the fees paid for the software |
| **Indirect Damages** | No liability for consequential, incidental, or punitive damages |
| **Business Losses** | No liability for lost profits, revenue, or opportunities |
| **Data Loss** | No liability for loss of data or information |
| **System Failures** | No liability for system failures or downtime |

### Open-Source Disclaimer

As open-source software under the Apache License 2.0, glayph/agent is provided **without warranty of any kind**, and the project maintainers are **not liable for any damages** arising from use. Users deploy the framework at their own risk.

---

## 🛡️ User Responsibilities

### Compliance Obligations

1. **Follow applicable laws**, including copyright, patent, and trade secret laws
2. **Respect third-party rights** and do not infringe intellectual property
3. **Maintain security** by implementing reasonable security measures
4. **Report violations** of security incidents or misuse
5. **Comply with regulations** applicable to your industry

### Data Protection

- **Respect privacy** and protect personal data
- **Comply with GDPR**, CCPA, and other privacy regulations
- **Minimize data collection** to what is necessary
- **Implement appropriate security** measures for your deployment

### License Compliance

- **Follow Apache License 2.0** requirements
- **Provide attribution** to original contributors
- **Make modified source** available under the same license
- **Preserve license notices** in all copies

---

## ⚠️ Operational Guidelines

### Deployment Requirements

1. **Review configuration** files (`config/agent.yaml`, `config/tools.yaml`) before deployment
2. **Scope tool permissions** to the minimum required for your use case
3. **Restrict system access** — the agent is designed to run with full system access
4. **Secure credentials** using the built-in secret vault, never in source control
5. **Enable API key authentication** for non-dashboard APIs in production

### Best Practices

| Area | Recommendation |
|------|----------------|
| **Sensitive Machines** | Review tool permissions before running on production hosts |
| **Browser Automation** | Restrict to trusted domains; browser rejects `javascript:`, `data:`, `file:` URLs |
| **Memory Store** | Encrypt the SQLite memory database and rotate keys regularly |
| **Logging** | Enable audit logging and monitor for anomalies |
| **Backups** | Configure automated backups of memory and config |

### Agent Persona Awareness

The runtime binaries are aliased as `hiro`, `Hiro`, `mikiagent`, `MikiAgent`, `agent`, and `Agent`. Ensure command-line scripts reference the intended alias for your deployment.

---

## 🔄 Termination

### Termination by User

You may discontinue use of glayph/agent at any time by:
1. Stopping all running agent processes
2. Removing the software from your systems
3. Deleting associated configuration and memory data

### Termination by Maintainers

The maintainers may terminate access in cases of:
- License or Terms of Service violations
- Illegal or harmful use of the software
- Attempts to disrupt or compromise the project

---

## 📄 Governing Law

These Terms of Service are governed by the laws of the jurisdiction in which the project maintainers are domiciled, without regard to conflict-of-law principles. Users are responsible for compliance with local laws in their own jurisdictions.

---

## 📧 Contact

For questions about these Terms of Service:

- **Project Repository**: https://github.com/glayph/agent
- **Issue Tracker**: Report issues via the GitHub issue tracker
- **Security Reports**: Report vulnerabilities privately through responsible disclosure

---

## 🔄 Updates to These Terms

The maintainers may update these Terms of Service from time to time. Material changes will be reflected in the repository's changelog. Continued use of the software after changes constitutes acceptance of the updated terms.

---

## ✅ Summary

By using glayph/agent, you agree to:

1. **Use the software lawfully** and for legitimate purposes
2. **Accept the "as is" warranty** disclaimer and limitation of liability
3. **Comply with the Apache License 2.0** requirements
4. **Deploy responsibly** with appropriate security controls
5. **Respect user privacy** and data protection regulations

The glayph/agent framework is provided as open-source software for autonomous AI agents. Deploy it responsibly, review permissions, and assume responsibility for your use.
