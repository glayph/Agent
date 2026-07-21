/**
 * StreamPredictor: Predict next tokens in a stream to improve perceived latency
 * - Predict next N tokens based on recent context
 * - Cache high-probability token sequences
 * - Enable speculative rendering on client
 */

export interface TokenPrediction {
  tokens: string[];
  probabilities: number[];
  confidence: number;
}

export class StreamPredictor {
  private tokenBuffer: string[] = [];
  private predictions: string[] = [];
  private tokenFrequency: Map<string, number> = new Map();
  private sequenceCache: Map<string, string[]> = new Map();

  private readonly BUFFER_SIZE = 20;
  private readonly PREDICTION_LENGTH = 5;
  private readonly MIN_CONFIDENCE = 0.6;

  /**
   * Initialize predictor with sample data
   */
  constructor(private sampleResponses: string[] = []) {
    this.initializeFromSamples();
  }

  /**
   * Initialize frequency map from sample responses
   */
  private initializeFromSamples(): void {
    for (const response of this.sampleResponses) {
      const tokens = response.split(" ");
      for (const token of tokens) {
        this.tokenFrequency.set(
          token,
          (this.tokenFrequency.get(token) || 0) + 1,
        );
      }
    }
  }

  /**
   * Add incoming token to buffer and update predictions
   */
  onToken(token: string): void {
    this.tokenBuffer.push(token);

    // Maintain buffer size
    if (this.tokenBuffer.length > this.BUFFER_SIZE) {
      this.tokenBuffer.shift();
    }

    // Update token frequency
    this.tokenFrequency.set(token, (this.tokenFrequency.get(token) || 0) + 1);

    // Recompute predictions every N tokens
    if (this.tokenBuffer.length % 3 === 0) {
      this.predictions = this.predictNext();
    }
  }

  /**
   * Predict next N tokens based on recent context
   */
  private predictNext(): string[] {
    if (this.tokenBuffer.length === 0) {
      return this.getMostCommonTokens(this.PREDICTION_LENGTH);
    }

    // Try sequence-based prediction first
    const recent = this.tokenBuffer.slice(-5).join(" ");
    const sequencePredictions = this.sequenceCache.get(recent);
    if (sequencePredictions) {
      return sequencePredictions;
    }

    // Fall back to frequency-based prediction
    return this.getMostCommonTokens(this.PREDICTION_LENGTH);
  }

  /**
   * Get most common tokens (frequency-based fallback)
   */
  private getMostCommonTokens(count: number): string[] {
    const sorted = Array.from(this.tokenFrequency.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, count)
      .map(([token]) => token);

    return sorted;
  }

  /**
   * Get current predictions
   */
  getPredictions(): TokenPrediction {
    const probs = this.computeProbabilities(this.predictions);
    const confidence = probs.length > 0 ? probs[0] : 0;

    return {
      tokens: this.predictions,
      probabilities: probs,
      confidence,
    };
  }

  /**
   * Compute probabilities for predicted tokens
   */
  private computeProbabilities(tokens: string[]): number[] {
    const total = Array.from(this.tokenFrequency.values()).reduce(
      (a, b) => a + b,
      0,
    );

    return tokens.map((token) => {
      const count = this.tokenFrequency.get(token) || 0;
      return total > 0 ? count / total : 0;
    });
  }

  /**
   * Train on new sequences
   */
  cacheSequence(context: string[], nextTokens: string[]): void {
    const key = context.join(" ");
    this.sequenceCache.set(key, nextTokens);
  }

  /**
   * Evaluate prediction accuracy (for model improvement)
   */
  evaluatePrediction(predicted: string[], actual: string): number {
    if (predicted.length === 0) return 0;

    // Check if actual token was in predictions
    if (predicted.includes(actual)) {
      const index = predicted.indexOf(actual);
      // Score based on position (earlier = better)
      return 1 - index / predicted.length;
    }

    return 0;
  }

  /**
   * Clear buffers (for new session)
   */
  reset(): void {
    this.tokenBuffer = [];
    this.predictions = [];
  }

  /**
   * Get predictor stats for monitoring
   */
  getStats(): {
    bufferSize: number;
    tokenFrequencySize: number;
    sequenceCacheSize: number;
  } {
    return {
      bufferSize: this.tokenBuffer.length,
      tokenFrequencySize: this.tokenFrequency.size,
      sequenceCacheSize: this.sequenceCache.size,
    };
  }
}

export const globalStreamPredictor = new StreamPredictor();
