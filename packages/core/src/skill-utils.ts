/**
 * Shared utility functions for skill management
 * Reduces code duplication across skill-related components
 */

import { getErrorMessage } from "./errors.js";

/**
 * Standard API response format
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  detail?: string;
}

/**
 * Create a success response
 */
export function createSuccessResponse<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
  };
}

/**
 * Create an error response
 */
export function createErrorResponse(
  message: string,
  error?: unknown,
): ApiResponse {
  return {
    success: false,
    error: message,
    detail: error ? getErrorMessage(error) : undefined,
  };
}

/**
 * Validate skill name format
 */
export function validateSkillName(name: string): { valid: boolean; error?: string } {
  if (!name || name.trim() === "") {
    return { valid: false, error: "Skill name is required" };
  }

  const trimmed = name.trim().toLowerCase();
  if (trimmed.length > 64) {
    return { valid: false, error: "Skill name exceeds 64 characters" };
  }

  const nameRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  if (!nameRegex.test(trimmed)) {
    return { valid: false, error: "Skill name must be alphanumeric with hyphens" };
  }

  return { valid: true };
}

/**
 * Normalize skill name to standard format
 */
export function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Validate skill metadata
 */
export interface SkillMetadata {
  name: string;
  description?: string;
  category?: string;
  tags?: string;
  version?: string;
  author?: string;
}

export function validateSkillMetadata(
  metadata: SkillMetadata,
): { valid: boolean; error?: string } {
  // Validate name
  const nameValidation = validateSkillName(metadata.name);
  if (!nameValidation.valid) {
    return nameValidation;
  }

  // Validate description
  if (metadata.description && metadata.description.length > 1024) {
    return { valid: false, error: "Skill description exceeds 1024 characters" };
  }

  // Validate category
  if (metadata.category) {
    if (metadata.category.length > 64) {
      return { valid: false, error: "Skill category exceeds 64 characters" };
    }
    const categoryRegex = /^[a-zA-Z0-9 _-]+$/;
    if (!categoryRegex.test(metadata.category)) {
      return { valid: false, error: "Skill category contains invalid characters" };
    }
  }

  // Validate tags
  if (metadata.tags) {
    const tagList = metadata.tags.split(",").map((t) => t.trim());
    for (const tag of tagList) {
      if (tag) {
        if (tag.length > 32) {
          return { valid: false, error: `Skill tag exceeds 32 characters: ${tag}` };
        }
        const tagRegex = /^[a-zA-Z0-9_-]+$/;
        if (!tagRegex.test(tag)) {
          return { valid: false, error: `Skill tag contains invalid characters: ${tag}` };
        }
      }
    }
  }

  // Validate version
  if (metadata.version) {
    if (metadata.version.length > 32) {
      return { valid: false, error: "Skill version exceeds 32 characters" };
    }
    const versionRegex = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/;
    if (!versionRegex.test(metadata.version)) {
      return { valid: false, error: "Skill version must follow semantic versioning (e.g., 1.0.0)" };
    }
  }

  // Validate author
  if (metadata.author && metadata.author.length > 128) {
    return { valid: false, error: "Skill author exceeds 128 characters" };
  }

  return { valid: true };
}

/**
 * Debounce function for rapid events
 */
export function debounce<T extends (...args: unknown[]) => void>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;

  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      timeout = null;
      func(...args);
    };

    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
}

/**
 * Safe JSON parse with fallback
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
