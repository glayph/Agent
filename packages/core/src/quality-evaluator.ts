/**
 * QualityEvaluator: Assess response quality and trigger fallback if needed
 * - Check coherence, safety, relevance, completeness
 * - Score responses on multiple dimensions
 * - Recommend retry with better model if quality insufficient
 */

export interface QualityScore {
  coherence: number;
  safety: number;
  relevance: number;
  completeness: number;
  overallScore: number;
  issues: string[];
}

export class QualityEvaluator {
  private readonly QUALITY_THRESHOLD = 0.7;
  private readonly MIN_SENTENCE_LENGTH = 5;
  private readonly MAX_SENTENCE_LENGTH = 30;

  /**
   * Evaluate response quality across multiple dimensions
   */
  async evaluate(response: string, task: string = ""): Promise<QualityScore> {
    const checks = {
      coherence: this.checkCoherence(response),
      safety: this.checkSafety(response),
      relevance: this.checkRelevance(response, task),
      completeness: this.checkCompleteness(response),
    };

    const scores = Object.values(checks);
    const overallScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    const issues = Object.entries(checks)
      .filter(([, v]) => v < this.QUALITY_THRESHOLD)
      .map(([k]) => `Low ${k}`);

    return {
      ...checks,
      overallScore: Math.max(0, Math.min(1, overallScore)),
      issues,
    };
  }

  /**
   * Check coherence: sentence structure and flow
   */
  private checkCoherence(response: string): number {
    if (!response || response.length < 10) return 0.2;

    const sentences = response
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 0);

    if (sentences.length === 0) return 0.2;

    // Compute average sentence length
    const avgLength =
      sentences.reduce((sum, s) => sum + s.split(" ").length, 0) /
      sentences.length;

    // Ideal: 5-30 words per sentence
    if (
      avgLength >= this.MIN_SENTENCE_LENGTH &&
      avgLength <= this.MAX_SENTENCE_LENGTH
    ) {
      return 0.9;
    }

    // Tolerate some variance
    if (avgLength >= 3 && avgLength <= 40) {
      return 0.7;
    }

    // Too short or too long sentences
    return 0.4;
  }

  /**
   * Check safety: detect harmful, offensive, or inappropriate content
   */
  private checkSafety(response: string): number {
    const dangerousPatterns = [
      /\b(kill|hurt|harm|die)\b/gi,
      /\b(illegal|crime|criminal)\b/gi,
      /\b(hack|breach|exploit)\b/gi,
    ];

    let dangerScore = 0;

    for (const pattern of dangerousPatterns) {
      if (pattern.test(response)) {
        dangerScore += 0.15;
      }
    }

    return Math.max(0, 1 - dangerScore);
  }

  /**
   * Check relevance: does response address the task?
   */
  private checkRelevance(response: string, task: string): number {
    if (!task) return 0.5; // Unknown task

    const taskWords = task.toLowerCase().split(/\s+/).slice(0, 5); // First 5 words
    const responseWords = response.toLowerCase().split(/\s+/);

    let matches = 0;
    for (const taskWord of taskWords) {
      if (
        taskWord.length > 3 &&
        responseWords.some((w) => w.includes(taskWord))
      ) {
        matches++;
      }
    }

    const relevanceScore = matches / Math.max(1, taskWords.length);
    return Math.max(0.3, Math.min(1, relevanceScore));
  }

  /**
   * Check completeness: does response answer the question fully?
   */
  private checkCompleteness(response: string): number {
    if (!response || response.length < 20) return 0.2;
    if (response.length < 50) return 0.4;
    if (response.length < 200) return 0.7;
    if (response.length < 1000) return 0.85;
    if (response.length < 5000) return 0.95;

    // Very long responses might be verbose
    return 0.8;
  }

  /**
   * Determine if response quality is acceptable
   */
  isAcceptable(score: QualityScore): boolean {
    return score.overallScore >= this.QUALITY_THRESHOLD;
  }

  /**
   * Get recommendation for improvement
   */
  getRecommendation(score: QualityScore): {
    shouldRetry: boolean;
    retryWithModel?: string;
    reason?: string;
  } {
    if (this.isAcceptable(score)) {
      return { shouldRetry: false };
    }

    let retryWithModel: string | undefined;

    // Recommend retry with better model based on issues
    if (score.issues.includes("Low coherence")) {
      retryWithModel = "gpt-4o"; // Better reasoning
    } else if (score.issues.includes("Low completeness")) {
      retryWithModel = "gpt-4o"; // More verbose
    } else if (
      score.issues.includes("Low relevance") &&
      score.issues.includes("Low coherence")
    ) {
      retryWithModel = "gpt-4o"; // Best model
    }

    return {
      shouldRetry: true,
      retryWithModel,
      reason: `Quality issues: ${score.issues.join(", ")}`,
    };
  }

  /**
   * Score single dimension (helper for testing)
   */
  scoreDimension(
    dimension: "coherence" | "safety" | "relevance" | "completeness",
    response: string,
    task?: string,
  ): number {
    switch (dimension) {
      case "coherence":
        return this.checkCoherence(response);
      case "safety":
        return this.checkSafety(response);
      case "relevance":
        return this.checkRelevance(response, task || "");
      case "completeness":
        return this.checkCompleteness(response);
    }
  }
}

export const globalQualityEvaluator = new QualityEvaluator();
