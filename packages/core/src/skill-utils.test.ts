/**
 * Tests for skill utility functions
 */

import {
  createSuccessResponse,
  createErrorResponse,
  validateSkillName,
  normalizeSkillName,
  validateSkillMetadata,
  debounce,
  safeJsonParse,
} from "./skill-utils.js";
import type { SkillMetadata } from "./skill-utils.js";

describe("skill-utils", () => {
  describe("createSuccessResponse", () => {
    it("should create a success response with data", () => {
      const data = { foo: "bar" };
      const response = createSuccessResponse(data);

      expect(response.success).toBe(true);
      expect(response.data).toEqual(data);
    });
  });

  describe("createErrorResponse", () => {
    it("should create an error response with message", () => {
      const response = createErrorResponse("Test error");

      expect(response.success).toBe(false);
      expect(response.error).toBe("Test error");
      expect(response.detail).toBeUndefined();
    });

    it("should include error detail when error is provided", () => {
      const error = new Error("Detailed error");
      const response = createErrorResponse("Test error", error);

      expect(response.success).toBe(false);
      expect(response.error).toBe("Test error");
      expect(response.detail).toBe("Detailed error");
    });
  });

  describe("validateSkillName", () => {
    it("should validate correct skill names", () => {
      expect(validateSkillName("my-skill").valid).toBe(true);
      expect(validateSkillName("my-skill-123").valid).toBe(true);
      expect(validateSkillName("test").valid).toBe(true);
    });

    it("should reject empty names", () => {
      const result = validateSkillName("");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Skill name is required");
    });

    it("should reject names with invalid characters", () => {
      expect(validateSkillName("My_Skill").valid).toBe(false);
      expect(validateSkillName("my skill").valid).toBe(false);
      expect(validateSkillName("my.skill").valid).toBe(false);
    });

    it("should reject names exceeding 64 characters", () => {
      const longName = "a".repeat(65);
      const result = validateSkillName(longName);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Skill name exceeds 64 characters");
    });
  });

  describe("normalizeSkillName", () => {
    it("should normalize skill names to standard format", () => {
      expect(normalizeSkillName("My_Skill")).toBe("my-skill");
      expect(normalizeSkillName("my skill")).toBe("my-skill");
      expect(normalizeSkillName("My.Skill")).toBe("my-skill");
      expect(normalizeSkillName("My--Skill")).toBe("my-skill");
      expect(normalizeSkillName("-my-skill-")).toBe("my-skill");
    });
  });

  describe("validateSkillMetadata", () => {
    it("should validate valid skill metadata", () => {
      const metadata: SkillMetadata = {
        name: "my-skill",
        description: "A test skill",
        category: "testing",
        tags: "test,utility",
        version: "1.0.0",
        author: "Test Author",
      };

      const result = validateSkillMetadata(metadata);
      expect(result.valid).toBe(true);
    });

    it("should reject invalid skill name", () => {
      const metadata: SkillMetadata = {
        name: "Invalid_Name",
      };

      const result = validateSkillMetadata(metadata);
      expect(result.valid).toBe(false);
    });

    it("should reject description exceeding 1024 characters", () => {
      const metadata: SkillMetadata = {
        name: "my-skill",
        description: "a".repeat(1025),
      };

      const result = validateSkillMetadata(metadata);
      expect(result.valid).toBe(false);
    });

    it("should reject invalid category", () => {
      const metadata: SkillMetadata = {
        name: "my-skill",
        category: "invalid@category",
      };

      const result = validateSkillMetadata(metadata);
      expect(result.valid).toBe(false);
    });

    it("should reject invalid tags", () => {
      const metadata: SkillMetadata = {
        name: "my-skill",
        tags: "valid-tag,invalid@tag",
      };

      const result = validateSkillMetadata(metadata);
      expect(result.valid).toBe(false);
    });

    it("should reject invalid version format", () => {
      const metadata: SkillMetadata = {
        name: "my-skill",
        version: "invalid",
      };

      const result = validateSkillMetadata(metadata);
      expect(result.valid).toBe(false);
    });

    it("should accept valid semantic versioning", () => {
      const metadata: SkillMetadata = {
        name: "my-skill",
        version: "1.0.0",
      };

      const result = validateSkillMetadata(metadata);
      expect(result.valid).toBe(true);
    });

    it("should accept version with pre-release", () => {
      const metadata: SkillMetadata = {
        name: "my-skill",
        version: "1.0.0-alpha",
      };

      const result = validateSkillMetadata(metadata);
      expect(result.valid).toBe(true);
    });
  });

  describe("debounce", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should debounce function calls", () => {
      const mockFn = jest.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn();
      debouncedFn();
      debouncedFn();

      jest.advanceTimersByTime(50);
      expect(mockFn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(50);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("should pass arguments to debounced function", () => {
      const mockFn = jest.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn("arg1", "arg2");
      jest.advanceTimersByTime(100);

      expect(mockFn).toHaveBeenCalledWith("arg1", "arg2");
    });
  });

  describe("safeJsonParse", () => {
    it("should parse valid JSON", () => {
      const json = '{"foo": "bar"}';
      const result = safeJsonParse(json, { fallback: true });

      expect(result).toEqual({ foo: "bar" });
    });

    it("should return fallback for invalid JSON", () => {
      const json = "invalid json";
      const fallback = { fallback: true };
      const result = safeJsonParse(json, fallback);

      expect(result).toEqual(fallback);
    });

    it("should return fallback for empty string", () => {
      const fallback = { fallback: true };
      const result = safeJsonParse("", fallback);

      expect(result).toEqual(fallback);
    });
  });
});
