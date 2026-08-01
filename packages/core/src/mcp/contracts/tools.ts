export interface ToolDefinition {
  type: "function";
  risk?: {
    level: "low" | "medium" | "high";
    label: string;
    reason: string;
  };
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolHandler {
  (args: Record<string, unknown>): string | Promise<string>;
}

export class ToolRegistrySchemas {
  static shellSchema(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "shell_execute",
          description:
            "Execute a shell command subject to config/tools.yaml permissions. OPEN or TRUSTED_FULL_ACCESS permits arbitrary local commands; workspace_only controls whether working_dir may leave the workspace.",
          parameters: {
            type: "object",
            properties: {
              cmd: {
                type: "string",
                description:
                  "A short command that must match the configured allowlist unless shell_execute.level is OPEN.",
              },
              working_dir: {
                type: "string",
                description:
                  "Optional working directory. Absolute paths allowed; relative paths resolve from the current directory.",
              },
              timeout: {
                type: "integer",
                description:
                  "Timeout in seconds (default: 30, capped by config).",
              },
            },
            required: ["cmd"],
          },
        },
      },
    ];
  }

  static fileSchemas(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "file_read",
          description:
            "Read file content. Supports both absolute and relative paths. Full filesystem access when TRUSTED_FULL_ACCESS is configured.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Absolute or relative path to the file. Relative paths resolve from the current working directory.",
              },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "file_write",
          description:
            "Create or overwrite a file anywhere on the filesystem. Supports absolute and relative paths.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Absolute or relative path to the file. Parent directories are created automatically.",
              },
              content: {
                type: "string",
                description: "The content to write into the file.",
              },
            },
            required: ["path", "content"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "file_delete",
          description:
            "Delete a file anywhere on the filesystem. Supports absolute and relative paths.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Absolute or relative path. Use caution when deleting outside known directories.",
              },
            },
            required: ["path"],
          },
        },
      },
    ];
  }

  static browserSchemas(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "browser_navigate",
          description:
            "Open a URL in the browser with anti-bot stealth, randomized user-agent, and auto-retry. Returns page title.",
          parameters: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "The full URL to navigate to.",
              },
            },
            required: ["url"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "browser_click",
          description:
            "Click an element. Supports CSS selectors, text=Visible Text, or xpath=//path. Uses human-like delays.",
          parameters: {
            type: "object",
            properties: {
              selector: {
                type: "string",
                description: "CSS, text=, or xpath= selector.",
              },
            },
            required: ["selector"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "browser_type",
          description:
            "Type text into an input field with human-like keystroke delays.",
          parameters: {
            type: "object",
            properties: {
              selector: {
                type: "string",
                description: "CSS selector of the input element.",
              },
              text: { type: "string", description: "The text to type." },
              enter: {
                type: "boolean",
                description: "Press Enter after typing. Default: false.",
              },
            },
            required: ["selector", "text"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "browser_invoke",
          description:
            "Invoke a browser element semantically without physical mouse movement. Target by selector, ARIA role/name, label, placeholder, or visible text.",
          parameters: {
            type: "object",
            properties: {
              selector: {
                type: "string",
                description: "Optional CSS, text=, or xpath= selector.",
              },
              role: {
                type: "string",
                description:
                  "Optional ARIA role, such as button, link, tab, or menuitem.",
              },
              name: {
                type: "string",
                description:
                  "Accessible name used with role or as text fallback.",
              },
              label: {
                type: "string",
                description: "Associated form label text.",
              },
              placeholder: {
                type: "string",
                description: "Input placeholder text.",
              },
              text: {
                type: "string",
                description: "Visible text to target.",
              },
              exact: {
                type: "boolean",
                description: "Require exact text/name matching. Default false.",
              },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "browser_fill",
          description:
            "Fill a browser field semantically without physical mouse movement. Target by selector, label, placeholder, role/name, or visible text.",
          parameters: {
            type: "object",
            properties: {
              selector: {
                type: "string",
                description: "Optional CSS, text=, or xpath= selector.",
              },
              role: {
                type: "string",
                description: "Optional ARIA role.",
              },
              name: {
                type: "string",
                description:
                  "Accessible name used with role or as text fallback.",
              },
              label: {
                type: "string",
                description: "Associated form label text.",
              },
              placeholder: {
                type: "string",
                description: "Input placeholder text.",
              },
              text: {
                type: "string",
                description: "Visible text target fallback.",
              },
              value: {
                type: "string",
                description: "Text value to fill.",
              },
              enter: {
                type: "boolean",
                description: "Press Enter after filling. Default false.",
              },
              exact: {
                type: "boolean",
                description: "Require exact target matching. Default false.",
              },
            },
            required: ["value"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "browser_press",
          description:
            "Press a keyboard key in the browser, optionally after focusing a semantic target. Does not use physical mouse movement.",
          parameters: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description:
                  "Playwright key name, such as Enter, Escape, Control+L, or ArrowDown.",
              },
              selector: {
                type: "string",
                description:
                  "Optional CSS, text=, or xpath= selector to focus first.",
              },
              role: { type: "string", description: "Optional ARIA role." },
              name: {
                type: "string",
                description:
                  "Accessible name used with role or as text fallback.",
              },
              label: {
                type: "string",
                description: "Associated form label text.",
              },
              placeholder: {
                type: "string",
                description: "Input placeholder text.",
              },
              text: {
                type: "string",
                description: "Visible text target fallback.",
              },
              exact: {
                type: "boolean",
                description: "Require exact target matching. Default false.",
              },
            },
            required: ["key"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "browser_extract",
          description:
            "Extract visible text from the current page or specific elements.",
          parameters: {
            type: "object",
            properties: {
              selector: {
                type: "string",
                description: "Optional CSS selector. Omits for full page.",
              },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "browser_screenshot",
          description:
            "Take a screenshot of the current page and save it locally.",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "browser_scroll",
          description:
            "Scroll the page down a random amount (400-900px) for human-like reading behavior.",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "browser_close",
          description: "Close the browser and free resources.",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
  }

  static computerSchemas(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "computer_observe",
          description:
            "Observe the current Windows desktop through the accessibility tree. Returns active window, top windows, and accessible UI elements with stable element_id values. Mouse-free.",
          parameters: {
            type: "object",
            properties: {
              window_title: {
                type: "string",
                description:
                  "Optional partial window title to observe. Defaults to the active window.",
              },
              process_name: {
                type: "string",
                description:
                  "Optional process name filter, such as Code, chrome, or notepad.",
              },
              window_handle: {
                type: "integer",
                description:
                  "Optional native window handle from a previous observation.",
              },
              query: {
                type: "string",
                description: "Optional text filter for returned elements.",
              },
              max_elements: {
                type: "integer",
                minimum: 1,
                maximum: 300,
                description:
                  "Maximum accessible elements to return. Default 80.",
              },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "computer_focus",
          description:
            "Focus a Windows application window by title, process, or window_handle using native window APIs. Mouse-free.",
          parameters: {
            type: "object",
            properties: {
              window_title: {
                type: "string",
                description: "Partial window title to focus.",
              },
              process_name: {
                type: "string",
                description: "Process name to focus.",
              },
              window_handle: {
                type: "integer",
                description: "Native window handle from computer_observe.",
              },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "computer_invoke",
          description:
            "Invoke an accessible UI element through UI Automation patterns such as Invoke, SelectionItem, Toggle, or ExpandCollapse. Uses element_id from computer_observe or semantic element fields. Mouse-free.",
          parameters: {
            type: "object",
            properties: {
              element_id: {
                type: "string",
                description: "Element ID returned by computer_observe.",
              },
              name: {
                type: "string",
                description: "Accessible element name fallback.",
              },
              automation_id: {
                type: "string",
                description: "AutomationId fallback.",
              },
              control_type: {
                type: "string",
                description:
                  "Control type fallback, such as Button, Edit, TabItem, MenuItem, or CheckBox.",
              },
              class_name: {
                type: "string",
                description: "Optional UI class name fallback.",
              },
              window_title: {
                type: "string",
                description: "Optional partial window title scope.",
              },
              process_name: {
                type: "string",
                description: "Optional process scope.",
              },
              window_handle: {
                type: "integer",
                description: "Optional native window handle scope.",
              },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "computer_set_text",
          description:
            "Set text in an accessible UI field using ValuePattern or keyboard clipboard paste fallback. Uses element_id from computer_observe or semantic element fields. Mouse-free.",
          parameters: {
            type: "object",
            properties: {
              element_id: {
                type: "string",
                description: "Element ID returned by computer_observe.",
              },
              text: {
                type: "string",
                description: "Text to set.",
              },
              name: {
                type: "string",
                description: "Accessible element name fallback.",
              },
              automation_id: {
                type: "string",
                description: "AutomationId fallback.",
              },
              control_type: {
                type: "string",
                description: "Control type fallback, usually Edit or Document.",
              },
              window_title: {
                type: "string",
                description: "Optional partial window title scope.",
              },
              process_name: {
                type: "string",
                description: "Optional process scope.",
              },
              window_handle: {
                type: "integer",
                description: "Optional native window handle scope.",
              },
            },
            required: ["text"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "computer_hotkey",
          description:
            "Send a keyboard shortcut to the active or targeted window. Supports Ctrl, Alt, Shift, Enter, Tab, Escape, arrows, Delete, and function keys. Mouse-free.",
          parameters: {
            type: "object",
            properties: {
              keys: {
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { type: "string" } },
                ],
                description: "Shortcut like Ctrl+S or ['Ctrl','Shift','P'].",
              },
              window_title: {
                type: "string",
                description: "Optional partial window title to focus first.",
              },
              process_name: {
                type: "string",
                description: "Optional process scope to focus first.",
              },
              window_handle: {
                type: "integer",
                description: "Optional native window handle to focus first.",
              },
            },
            required: ["keys"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "computer_clipboard",
          description:
            "Read, set, or clear the Windows clipboard for clipboard-first automation. Mouse-free.",
          parameters: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["get", "set", "clear"],
                description: "Clipboard operation. Default get.",
              },
              text: {
                type: "string",
                description: "Text to set when action is set.",
              },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "computer_launch",
          description:
            "Launch a local application with shell=false, then use computer_observe/focus/invoke for deterministic control. Mouse-free.",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
                description:
                  "Executable or app alias to launch, such as notepad.exe or code.",
              },
              args: {
                type: "array",
                items: { type: "string" },
                description: "Optional process arguments.",
              },
              working_dir: {
                type: "string",
                description:
                  "Optional working directory. Absolute paths allowed; relative paths resolve from the current directory.",
              },
            },
            required: ["command"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "computer_verify",
          description:
            "Verify that accessible UI state contains or does not contain text after an action. Mouse-free observe-act-verify support.",
          parameters: {
            type: "object",
            properties: {
              contains: {
                type: "string",
                description: "Text that should appear in accessible UI state.",
              },
              not_contains: {
                type: "string",
                description:
                  "Text that should not appear in accessible UI state.",
              },
              window_title: {
                type: "string",
                description: "Optional partial window title scope.",
              },
              process_name: {
                type: "string",
                description: "Optional process scope.",
              },
              window_handle: {
                type: "integer",
                description: "Optional native window handle scope.",
              },
              max_elements: {
                type: "integer",
                minimum: 1,
                maximum: 300,
                description:
                  "Maximum accessible elements to scan. Default 120.",
              },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "computer_screenshot",
          description:
            "Capture a screenshot of the primary display. Returns the image as base64-encoded PNG.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "computer_list_processes",
          description:
            "List running processes sorted by CPU usage. Returns PID, name, CPU, memory, and start time.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "computer_get_system_info",
          description:
            "Retrieve system information including OS version, architecture, total memory, CPU, and model.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "computer_list_displays",
          description:
            "List all connected displays with their bounds, working area, and primary status.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      },
    ];
  }

  static modelSchemas(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "model_list",
          description:
            "List all available models for the provider. Returns both built-in and provider-specific models.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
      {
        type: "function",
        function: {
          name: "model_add",
          description:
            "Add a new model to the provider's associated models list. Restricted to provider permission.",
          parameters: {
            type: "object",
            properties: {
              model_name: {
                type: "string",
                description:
                  "The model name to add (e.g., 'anthropic/claude-3-opus', 'openai/gpt-4-turbo')",
              },
            },
            required: ["model_name"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "model_delete",
          description:
            "Delete a model from the provider's associated models list. Restricted to provider permission.",
          parameters: {
            type: "object",
            properties: {
              model_name: {
                type: "string",
                description: "The model name to delete",
              },
            },
            required: ["model_name"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "model_select",
          description:
            "Select a model as the active model for the provider. Restricted to provider permission.",
          parameters: {
            type: "object",
            properties: {
              model_name: {
                type: "string",
                description: "The model name to select as active",
              },
            },
            required: ["model_name"],
          },
        },
      },
    ];
  }

  static directDownloadSchema(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "direct_download_search",
          description:
            'Builds a Google Dork search URL targeting open directory listings ("Index of" pages) for direct file downloads. Supports movies, music, books, software, images, and general files. Returns a ready-to-use search URL. After calling this tool, use scrape_page(url) or browser_navigate(url) with the returned URL to fetch results.',
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "The search term (e.g. 'The Avengers 2012', 'K.Flay discography')",
              },
              fileType: {
                type: "string",
                enum: ["video", "audio", "ebook", "software", "image", "all"],
                description: "Category of file to search for",
              },
              engine: {
                type: "string",
                enum: ["google", "startpage", "searx", "filepursuit"],
                description: "Search engine to use (default: google)",
              },
            },
            required: ["query", "fileType"],
          },
        },
      },
    ];
  }

  static projectWorkflowSchemas(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "project_workflow_create",
          description:
            "Create a deterministic implementation workflow for any complex project or multi-step task from a user brief or sketch. Produces architecture, file tree, milestones, verification gates, risk register, review loop, and optional gate execution evidence.",
          parameters: {
            type: "object",
            properties: {
              brief: {
                type: "string",
                description:
                  "The user's project brief, sketch description, or requirements.",
              },
              project_name: {
                type: "string",
                description:
                  "Optional project name. If omitted, one is inferred from the brief.",
              },
              target_type: {
                type: "string",
                enum: [
                  "app",
                  "website",
                  "library",
                  "game",
                  "automation",
                  "simulation",
                  "complex_task",
                  "os",
                  "other",
                ],
                description:
                  "Project category. Use 'complex_task' for arbitrary multi-step complex work, 'os' for kernel/bootloader/emulator style requests, and 'simulation' for deterministic model/engine/scenario systems.",
              },
              constraints: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional constraints such as language, framework, platform, latency, or security requirements.",
              },
              write_files: {
                type: "boolean",
                description:
                  "When true or omitted, writes workflow.json and README.md under data/project-workflows.",
              },
              scaffold_files: {
                type: "boolean",
                description:
                  "When true, also creates the guarded starter file tree described by the workflow. Existing files are skipped unless overwrite is true.",
              },
              overwrite: {
                type: "boolean",
                description:
                  "Allow scaffold_files to overwrite existing scaffold files. Default false.",
              },
              run_gates: {
                type: "boolean",
                description:
                  "When true, creates the scaffold if needed and runs selected verification gates with shell-free commands inside the generated project root.",
              },
              gate_names: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional verification gate names to run, such as build, smoke, simulate, or unit tests. Runs all gates when omitted.",
              },
              gate_timeout_ms: {
                type: "integer",
                description:
                  "Per-gate timeout in milliseconds. Clamped between 1000 and 300000. Default 30000.",
              },
              output_dir: {
                type: "string",
                description:
                  "Optional workspace-relative output directory for the workflow artifact.",
              },
            },
            required: ["brief"],
          },
        },
      },
    ];
  }

  static goalSchemas(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "goal_create",
          description:
            "Create an active pursue goal that persists across turns. Use this for complex objectives that need planning, implementation, verification, and explicit completion/blocking state.",
          parameters: {
            type: "object",
            properties: {
              objective: {
                type: "string",
                description:
                  "The concrete objective to pursue until completed, blocked, cancelled, or replaced.",
              },
              description: {
                type: "string",
                description:
                  "Optional additional details, constraints, or acceptance criteria.",
              },
              priority: {
                type: "integer",
                description: "Priority from 0 to 10. Default 5.",
              },
              steps: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional ordered plan steps. Defaults to inspect, plan, implement, verify, and report.",
              },
              replace_existing: {
                type: "boolean",
                description:
                  "When true, demotes the current active goal and starts this one.",
              },
              context: {
                type: "object",
                description:
                  "Optional structured context for the goal, such as source channel or linked files.",
              },
            },
            required: ["objective"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "goal_status",
          description:
            "Return the current active pursue goal, active plan, and recent goal history.",
          parameters: {
            type: "object",
            properties: {
              limit: {
                type: "integer",
                description: "Maximum number of recent goals to return.",
              },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "goal_update",
          description:
            "Update the active pursue goal or a specific goal. Use this to record progress, mark blocked/completed/cancelled, or revise the plan.",
          parameters: {
            type: "object",
            properties: {
              goal_id: {
                type: "integer",
                description:
                  "Optional goal ID. Defaults to the active pursue goal.",
              },
              objective: {
                type: "string",
                description: "Optional revised objective title.",
              },
              description: {
                type: "string",
                description: "Optional revised description.",
              },
              status: {
                type: "string",
                enum: [
                  "pending",
                  "active",
                  "completed",
                  "blocked",
                  "cancelled",
                ],
                description:
                  "Goal lifecycle status. Mark completed only after objective evidence is satisfied.",
              },
              status_reason: {
                type: "string",
                description:
                  "Short reason or blocker evidence for the status change.",
              },
              progress: {
                type: "number",
                description: "Progress ratio between 0 and 1.",
              },
              completed_steps: {
                type: "integer",
                description: "Number of completed plan steps.",
              },
              total_steps: {
                type: "integer",
                description: "Total number of plan steps.",
              },
              steps: {
                type: "array",
                items: { type: "string" },
                description: "Optional replacement ordered plan steps.",
              },
              context: {
                type: "object",
                description: "Optional replacement structured context.",
              },
            },
            required: [],
          },
        },
      },
    ];
  }

  static scraperSchemas(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "scrape_page",
          description:
            "Navigate to a URL and extract the full page content as clean Markdown. Uses html2text, stealth, randomized UA, and auto-retry on failure. Best for reading articles, documentation, or any full-page content.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "The URL to scrape." },
              as_markdown: {
                type: "boolean",
                description: "Return as Markdown (default: true).",
              },
            },
            required: ["url"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "scrape_selectors",
          description:
            "Extract specific elements from a page using CSS selectors or XPaths. Returns each match as Markdown. Good for scraping specific data points like prices, titles, or tables.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "The URL to scrape." },
              selectors: {
                type: "array",
                items: { type: "string" },
                description: "List of CSS selectors or XPaths to extract.",
              },
            },
            required: ["url", "selectors"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "scrape_paginated",
          description:
            "Scrape multiple pages by clicking a 'Next' button. Extracts each page as Markdown and concatenates results. Handles disabled next buttons and no-more-pages gracefully.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "The first page URL." },
              next_selector: {
                type: "string",
                description: "CSS selector for the 'Next' button/link.",
              },
              max_pages: {
                type: "integer",
                description: "Max pages to scrape (default: 5).",
              },
            },
            required: ["url", "next_selector"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "scrape_infinite_scroll",
          description:
            "Scrape a page with infinite-scroll or 'load more' content. Scrolls to the bottom multiple times, waits for content to load between scrolls, then extracts all content as Markdown.",
          parameters: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "The URL with infinite scroll content.",
              },
              max_scrolls: {
                type: "integer",
                description: "Maximum scroll attempts (default: 10).",
              },
            },
            required: ["url"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "scrape_json",
          description:
            "Fetch JSON data from an API endpoint using the browser's fetch API (bypasses CORS). Returns formatted JSON. Retries with rotated identity on failure.",
          parameters: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "The API URL to fetch JSON from.",
              },
            },
            required: ["url"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "scrape_table",
          description:
            "Extract an HTML table from the current page as a Markdown-formatted table.",
          parameters: {
            type: "object",
            properties: {
              selector: {
                type: "string",
                description:
                  "CSS selector of the table element (default: 'table').",
              },
            },
            required: [],
          },
        },
      },
    ];
  }
}
