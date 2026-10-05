/**
 * Static heuristics for third-party skills. A match is a signal for the person
 * installing (they can still force the install), not proof of malice.
 */
const RULES = [
    {
        id: "pipe-to-shell",
        description: "Downloads content and pipes it straight into a shell.",
        pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
    },
    {
        id: "destructive-delete",
        description: "Recursively deletes the filesystem root or the home folder.",
        pattern: /\brm\s+(?:-[a-z]+\s+)*(?:\/|~|\$HOME)(?:\/\*)?(?:\s|$)/i,
    },
    {
        id: "encoded-exec",
        description: "Decodes an obfuscated payload and executes it.",
        pattern: /base64\s+(?:-d|--decode)[^\n]*\|\s*(?:ba)?sh\b|eval\s*\(\s*(?:atob|Buffer\.from)/i,
    },
    {
        id: "reverse-shell",
        description: "Opens a network shell back to another machine.",
        pattern: /\/dev\/tcp\/|\bnc\s+(?:-[a-z]*e|--exec)\b|bash\s+-i\s*>&/i,
    },
    {
        id: "credential-access",
        description: "Reads SSH keys, cloud credentials or system password files.",
        pattern: /\.ssh\/id_[a-z0-9]+|\.aws\/credentials|\/etc\/shadow/i,
    },
    {
        id: "prompt-injection",
        description: "Tries to override the agent's instructions or hide actions from the user.",
        pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|do\s+not\s+(?:tell|inform|alert)\s+the\s+user|without\s+(?:asking|telling|informing)\s+the\s+user/i,
    },
    {
        id: "encoded-blob",
        description: "Contains a very large encoded blob that cannot be reviewed.",
        pattern: /[A-Za-z0-9+/=]{2000,}/,
    },
];
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_FINDINGS = 20;
export function looksLikeText(data) {
    const sample = data.subarray(0, Math.min(data.length, 4096));
    return !sample.includes(0);
}
/** Scan files (relative path + bytes) and return at most 20 findings. */
export function scanSkillFiles(files) {
    const findings = [];
    for (const file of files) {
        if (file.data.length > MAX_TEXT_BYTES || !looksLikeText(file.data))
            continue;
        const lines = file.data.toString("utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            for (const rule of RULES) {
                if (!rule.pattern.test(lines[index]))
                    continue;
                findings.push({
                    rule: rule.id,
                    description: rule.description,
                    file: file.path,
                    line: index + 1,
                    excerpt: lines[index].trim().slice(0, 120),
                });
                if (findings.length >= MAX_FINDINGS)
                    return findings;
            }
        }
    }
    return findings;
}
export function summarizeFindings(findings) {
    const rules = [...new Set(findings.map((finding) => finding.rule))];
    return `${findings.length} suspicious pattern(s): ${rules.join(", ")}.`;
}
