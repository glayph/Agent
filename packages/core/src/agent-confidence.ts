/**
 * ConfidenceScorer: Agent confidence in decisions
 * - Score confidence on multiple factors
 * - Know when to ask for help vs act confidently
 * - Calibrate confidence scores over time
 */

export interface ConfidenceFactors {
  memorySupport: number; // 0-1: how much memory supports this
  toolSuccess: number; // 0-1: historical success rate of tool
  queryClarity: number; // 0-1: how clear is the query
  ambiguity: number; // 0-1: ambiguity level in query
}

export interface ConfidenceAssessment {
  confidence: number; // 0-1
  factors: ConfidenceFactors;
  shouldAsk: boolean;
  taskType: string;
}

export class ConfidenceScorer {
  private toolSuccessRates: Map<string, number> = new Map();
  private confidencePredictions: Array<{ predicted: number; actual: number }> =
    [];

  private readonly CALIBRATION_THRESHOLD = 0.1; // When to recalibrate

  /**
   * Score decision confidence
   */
  async scoreDecision(
    toolName: string,
    query: string,
    taskType: string = "general",
    hasMemory: boolean = false,
  ): Promise<ConfidenceAssessment> {
    const factors: ConfidenceFactors = {
      memorySupport: await this.checkMemorySupport(hasMemory),
      toolSuccess: this.checkToolSuccessRate(toolName),
      queryClarity: this.scoreQueryClarity(query),
      ambiguity: this.detectAmbiguity(query),
    };

    const confidence =
      factors.memorySupport * 0.25 +
      factors.toolSuccess * 0.3 +
      factors.queryClarity * 0.25 -
      factors.ambiguity * 0.2;

    const finalConfidence = Math.max(0, Math.min(1, confidence));
    const shouldAsk = this.shouldAskForConfirmation(finalConfidence, taskType);

    return {
      confidence: finalConfidence,
      factors,
      shouldAsk,
      taskType,
    };
  }

  /**
   * Check if memory supports the decision
   */
  private async checkMemorySupport(hasMemory: boolean): Promise<number> {
    return hasMemory ? 0.8 : 0.3;
  }

  /**
   * Check tool success rate
   */
  private checkToolSuccessRate(toolName: string): number {
    const rate = this.toolSuccessRates.get(toolName);
    if (rate === undefined) {
      return 0.6; // Unknown tool
    }
    return rate;
  }

  /**
   * Score query clarity
   */
  private scoreQueryClarity(query: string): number {
    const length = query.length;
    const complexity = (query.match(/[,;:]/g) || []).length;
    const questionMarks = (query.match(/\?/g) || []).length;

    let clarity = 0;

    // Good length (10-200 chars)
    if (length >= 10 && length <= 200) clarity += 0.3;
    else if (length < 5) clarity -= 0.2;
    else if (length > 500) clarity -= 0.1;

    // Moderate complexity
    if (complexity <= 3) clarity += 0.3;
    else if (complexity > 5) clarity -= 0.1;

    // Single or double question
    if (questionMarks === 1) clarity += 0.2;
    else if (questionMarks > 2) clarity -= 0.1;

    return Math.max(0, Math.min(1, 0.3 + clarity));
  }

  /**
   * Detect ambiguity in query
   */
  private detectAmbiguity(query: string): number {
    let ambiguity = 0;
    const lower = query.toLowerCase();

    // Ambiguity signals
    const ambiguousWords = [
      "maybe",
      "possibly",
      "unclear",
      "not sure",
      "confused",
      "which",
      "either",
      "or",
    ];

    for (const word of ambiguousWords) {
      if (lower.includes(word)) {
        ambiguity += 0.15;
      }
    }

    // Lack of specificity
    if (lower.includes("something") || lower.includes("anything")) {
      ambiguity += 0.2;
    }

    return Math.min(1, ambiguity);
  }

  /**
   * Determine if we should ask for confirmation
   */
  private shouldAskForConfirmation(
    confidence: number,
    taskType: string,
  ): boolean {
    const thresholds: Record<string, number> = {
      read: 0.6,
      write: 0.8,
      delete: 0.95,
      plan: 0.5,
      execute: 0.7,
      general: 0.7,
    };

    const threshold = thresholds[taskType] ?? 0.7;
    return confidence < threshold;
  }

  /**
   * Record tool success for calibration
   */
  recordToolSuccess(toolName: string, wasSuccessful: boolean): void {
    const current = this.toolSuccessRates.get(toolName) ?? 0.5;
    // Exponential moving average
    const updated = current * 0.7 + (wasSuccessful ? 1 : 0) * 0.3;
    this.toolSuccessRates.set(toolName, updated);
  }

  /**
   * Calibrate confidence predictions
   */
  recordPrediction(predicted: number, actual: boolean): void {
    this.confidencePredictions.push({
      predicted,
      actual: actual ? 1 : 0,
    });

    // Recalibrate if error too large
    if (this.confidencePredictions.length > 10) {
      this.calibrateIfNeeded();
    }
  }

  /**
   * Check if calibration is needed
   */
  private calibrateIfNeeded(): void {
    if (this.confidencePredictions.length < 10) return;

    const recent = this.confidencePredictions.slice(-10);
    let totalError = 0;

    for (const pred of recent) {
      totalError += Math.abs(pred.predicted - pred.actual);
    }

    const averageError = totalError / recent.length;

    if (averageError > this.CALIBRATION_THRESHOLD) {
      console.log(
        `Confidence calibration needed. Average error: ${averageError.toFixed(3)}`,
      );
      // In production, adjust confidence model
    }
  }

  /**
   * Get confidence stats
   */
  getStats(): {
    toolCount: number;
    totalPredictions: number;
    calibrationError: number;
  } {
    const calibrationError =
      this.confidencePredictions.length > 0
        ? this.confidencePredictions.reduce(
            (sum, p) => sum + Math.abs(p.predicted - p.actual),
            0,
          ) / this.confidencePredictions.length
        : 0;

    return {
      toolCount: this.toolSuccessRates.size,
      totalPredictions: this.confidencePredictions.length,
      calibrationError,
    };
  }

  /**
   * Export calibration data
   */
  exportCalibration(): {
    toolRates: Record<string, number>;
    predictions: Array<{ predicted: number; actual: number }>;
  } {
    const toolRates: Record<string, number> = {};
    for (const [tool, rate] of this.toolSuccessRates) {
      toolRates[tool] = rate;
    }

    return {
      toolRates,
      predictions: this.confidencePredictions,
    };
  }

  /**
   * Clear stats
   */
  clear(): void {
    this.toolSuccessRates.clear();
    this.confidencePredictions = [];
  }
}

export const globalConfidenceScorer = new ConfidenceScorer();
